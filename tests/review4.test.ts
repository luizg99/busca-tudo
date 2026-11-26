import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPage, isPrivateHost } from '../src/service/fetcher';
import { extractGenericPrice } from '../src/service/html';
import { isRiskyPattern } from '../src/service/sources';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { FetchResult } from '../src/service/fetcher';
import type { NewTracker } from '../src/shared/types';

describe('#1 timeout no meio do corpo continua sendo "timeout"', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));

  it('servidor que manda o cabeçalho e trava no corpo → kind timeout', async () => {
    server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<p>começo'); /* nunca termina */ });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const r = await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'], timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect((r as any).message).toMatch(/demorou/);
  });

  it('host liberado por nome (allowedHosts) também libera o IP para onde ele resolve', async () => {
    server = createServer((_req, res) => res.writeHead(200).end('<p>ok</p>'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const r = await fetchPage(`http://localhost:${port}/`, { allowedHosts: ['localhost'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    expect(r).toEqual({ ok: true, html: '<p>ok</p>' });
  });
});

describe('#2 endereços internos: IPv6 só se for público global; IPv4 reservado completo', () => {
  it('bloqueia NAT64, IPv4-compatível, 6to4 de IP interno, Teredo, multicast, documentação e o resto de IPv6 não global', () => {
    for (const h of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::', '2002:c0a8:1::', '2001::1', '2001:db8::1', 'ff02::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::1', '::', '[::1]', '::ffff:7f00:1', '::ffff:127.0.0.1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });
  it('deixa passar IPv6 público e 6to4 de IP público', () => {
    for (const h of ['2606:4700::1111', '2a00:1450:4001:81b::200e', '[2606:4700:4700::1111]', '2002:808:808::', '::ffff:808:808']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
  it('bloqueia multicast, reservado, broadcast e blocos de documentação em IPv4', () => {
    for (const h of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['8.8.8.8', '200.147.1.1', '172.32.0.1', '223.255.255.1']) expect(isPrivateHost(h), h).toBe(false);
  });
  it('fetchPage recusa as formas novas sem tentar conectar', async () => {
    for (const u of ['http://[64:ff9b::7f00:1]/', 'http://[::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://224.0.0.1/']) {
      expect(await fetchPage(u, { timeoutMs: 1500 }), u).toMatchObject({ ok: false, kind: 'invalid' });
    }
  });
});

describe('#5 tipo do produto principal em formas equivalentes', () => {
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const accessories = ld({ '@type': 'Thing', name: 'Capinha', offers: { price: 90 } });
  it.each(['https://schema.org/Product', 'http://schema.org/Product', 'schema:Product', 'ProductGroup', 'IndividualProduct', ['Thing', 'Product']])('reconhece %j', (type) => {
    expect(extractGenericPrice(accessories + ld({ '@type': type, offers: { price: 3000 } }))).toBe(3000);
  });
});

describe('#6 repetição com limite grande conta como sem limite', () => {
  it('(a+){1,50}, (\\d+\\s*){2,30} e {n} grande em grupo com repetição interna são arriscados', () => {
    expect(isRiskyPattern('(a+){1,50}x')).toBe(true);
    expect(isRiskyPattern('(\\d+\\s*){2,30}x')).toBe(true);
    expect(isRiskyPattern('(\\d+){40}x')).toBe(true);
  });
  it('padrões comuns e repetição pequena continuam permitidos', () => {
    expect(isRiskyPattern('(\\d+){1,3}')).toBe(false);
    expect(isRiskyPattern('Digital.{0,30}?R\\$\\s*([\\d.,]+)\\s*no pix')).toBe(false);
    expect(isRiskyPattern('R\\$\\s*([\\d.,]{1,12})')).toBe(false);
  });
});

describe('#3 "Verificar agora" ignora a espera de 1 h depois de busca falha', () => {
  const tracker: NewTracker = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none' };
  it('verificação agendada espera; a manual roda a busca na hora', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(tracker);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    let clock = new Date('2026-01-10T10:00:00Z').getTime();
    const now = () => new Date(clock);
    let searches = 0;
    const llm: LlmClient = {
      async search() { searches++; throw new Error('API fora do ar'); },
      async chat() { throw new Error('x'); },
    };
    const fetchPage = async (): Promise<FetchResult> => ({ ok: false, kind: 'http', status: 404, message: '404' });
    const deps = { db, llm, notifier: new Notifier(db, transport, now), models: { routine: 'm', escalate: 'm2' }, now, fetchPage };
    await runCheck(deps, t.id);
    expect(searches).toBe(1);
    clock += 15 * 60000;
    expect((await runCheck(deps, t.id)).error).toMatch(/falhou há pouco/i);
    expect(searches).toBe(1);
    const manual = await runCheck(deps, t.id, { manual: true });
    expect(searches).toBe(2); // a ação manual ignorou a espera
    expect(manual.error).not.toMatch(/falhou há pouco/i);
  });
});
