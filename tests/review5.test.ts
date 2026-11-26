import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPage, isPrivateHost } from '../src/service/fetcher';
import { isRiskyPattern } from '../src/service/sources';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { FetchResult } from '../src/service/fetcher';
import type { NewTracker } from '../src/shared/types';

describe('#1 conexão que cai no meio do corpo não vira página "completa"', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  async function serve(handler: (req: any, res: any) => void) {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server!.address() as AddressInfo).port;
  }

  it('servidor que manda metade da página e derruba a conexão → falha, não { ok: true } truncado', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '5000' });
      res.write('<p>metade da página');
      setTimeout(() => res.socket?.destroy(), 40);
    });
    const r = await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'], timeoutMs: 3000 });
    expect(r.ok).toBe(false);
  });

  it('corpo que termina normalmente continua sendo sucesso, e o limite de tamanho continua cortando sem erro', async () => {
    const port = await serve((_req, res) => res.writeHead(200).end('x'.repeat(5000)));
    const full = await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'] });
    expect(full.ok && full.html.length).toBe(5000);
    const capped = await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'], maxBytes: 1000 });
    expect(capped.ok).toBe(true);
    expect((capped as any).html.length).toBeLessThanOrEqual(1000);
  });
});

describe('#2 NAT64: vale o IPv4 embutido', () => {
  it('64:ff9b::/96 com IPv4 público passa; com IPv4 interno é bloqueado', () => {
    expect(isPrivateHost('64:ff9b::808:808')).toBe(false); // 8.8.8.8
    expect(isPrivateHost('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateHost('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateHost('64:ff9b::c0a8:1')).toBe(true); // 192.168.0.1
  });
  it('64:ff9b:1::/48 (NAT64 local) e outros prefixos seguem bloqueados', () => {
    expect(isPrivateHost('64:ff9b:1::808:808')).toBe(true);
  });
});

describe('#3 host liberado por nome só isenta endereços de loopback', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));

  it('nome liberado que resolve para metadados de nuvem continua bloqueado', async () => {
    const r = await fetchPage('http://liberado.test/', { allowedHosts: ['liberado.test'], resolver: async () => [{ address: '169.254.169.254', family: 4 }], timeoutMs: 1500 });
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('nome liberado que resolve para rede privada continua bloqueado', async () => {
    const r = await fetchPage('http://liberado.test/', { allowedHosts: ['liberado.test'], resolver: async () => [{ address: '10.0.0.5', family: 4 }, { address: '127.0.0.1', family: 4 }], timeoutMs: 1500 });
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('nome liberado que resolve para loopback funciona (uso nos testes locais)', async () => {
    server = createServer((_req, res) => res.writeHead(200).end('<p>ok</p>'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const r = await fetchPage(`http://liberado.test:${port}/`, { allowedHosts: ['liberado.test'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    expect(r).toEqual({ ok: true, html: '<p>ok</p>' });
  });
});

describe('#4 filtro de ReDoS: grupos de largura fixa são seguros', () => {
  it('(\\d{4}-\\d{2})+, (?:\\d{3}\\.?)+ e a regra completa com milhar são permitidos', () => {
    expect(isRiskyPattern('(\\d{4}-\\d{2})+')).toBe(false);
    expect(isRiskyPattern('(?:\\s\\d{4})*')).toBe(false);
    expect(isRiskyPattern('R\\$\\s*((?:\\d{3}\\.?)+,\\d{2})')).toBe(false);
    expect(isRiskyPattern('(\\d{1,3}(?:\\.\\d{3})*,\\d{2})')).toBe(false);
  });
  it('continuam recusados: interno sem limite + externo repetido, ou repetição externa grande', () => {
    expect(isRiskyPattern('(a+){1,50}x')).toBe(true);
    expect(isRiskyPattern('(\\d+\\s*){2,30}x')).toBe(true);
    expect(isRiskyPattern('(\\d+){40}x')).toBe(true);
    expect(isRiskyPattern('(a+)+$')).toBe(true);
    expect(isRiskyPattern('((a|aa))+$')).toBe(true);
    expect(isRiskyPattern('(\\d+){1,3}')).toBe(false);
  });
});

describe('#5 cliques repetidos em "Verificar agora" não repetem a busca cara', () => {
  const tracker: NewTracker = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none' };
  it('manual espera 2 min depois de uma busca que falhou; passado isso roda', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(tracker);
    const transport: Transport = { isReady: () => true, async sendToSelf() {} };
    let clock = new Date('2026-01-10T10:00:00Z').getTime();
    const now = () => new Date(clock);
    let searches = 0;
    const llm: LlmClient = { async search() { searches++; throw new Error('API fora do ar'); }, async chat() { throw new Error('x'); } };
    const fetchPage = async (): Promise<FetchResult> => ({ ok: false, kind: 'http', status: 404, message: '404' });
    const deps = { db, llm, notifier: new Notifier(db, transport, now), models: { routine: 'm', escalate: 'm2' }, now, fetchPage };
    await runCheck(deps, t.id, { manual: true });
    expect(searches).toBe(1);
    clock += 60_000; // 1 min depois
    const again = await runCheck(deps, t.id, { manual: true });
    expect(searches).toBe(1);
    expect(again.error).toMatch(/aguarde/i);
    clock += 2 * 60_000; // 3 min depois da falha
    await runCheck(deps, t.id, { manual: true });
    expect(searches).toBe(2);
  });
});
