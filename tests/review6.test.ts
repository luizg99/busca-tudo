import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fetchPage, isLoopbackAddress } from '../src/service/fetcher';
import { isRiskyPattern } from '../src/service/sources';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { FetchResult } from '../src/service/fetcher';
import type { NewTracker } from '../src/shared/types';

describe('#1 ReDoS: largura variável é o que importa, não só * e +', () => {
  it('recusa repetição larga de grupo com repetição de largura variável por dentro', () => {
    for (const p of ['(a{1,50})+$', '(\\d{1,50})*x', '(\\d{1,40}){1,40}x', '(a+)+$', '((a|aa))+$', '(\\d+){40}x', '(\\d+\\s*){2,30}x', '(?:a{2,9})*b']) {
      expect(isRiskyPattern(p), p).toBe(true);
    }
  });
  it('permite grupos de largura fixa e regras comuns de preço', () => {
    for (const p of ['(\\d{4}-\\d{2})+', '(?:\\s\\d{4})*', 'R\\$\\s*((?:\\d{3}\\.?)+,\\d{2})', '(\\d{1,3}(?:\\.\\d{3})*,\\d{2})', '(\\d+){1,3}', 'R\\$\\s*([\\d.,]{1,12})', 'Digital.{0,30}?R\\$\\s*([\\d.,]+)\\s*no pix']) {
      expect(isRiskyPattern(p), p).toBe(false);
    }
  });
});

describe('#2 resposta compactada cortada falha rápido (não pendura até o timeout)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));

  for (const encoding of ['gzip'] as const) {
    it(`${encoding} interrompido no meio → falha de conexão em poucos segundos`, async () => {
      const html = '<p>' + 'preço '.repeat(20000) + '</p>';
      const full = gzipSync(html);
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-encoding': encoding, 'content-type': 'text/html; charset=utf-8', 'content-length': String(full.length) });
        res.write(full.subarray(0, Math.floor(full.length / 2)));
        setTimeout(() => res.socket?.destroy(), 40);
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      const t0 = Date.now();
      const r = await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'], timeoutMs: 6000 });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ kind: 'network' });
      expect(Date.now() - t0).toBeLessThan(3000);
    });
  }

  it('gzip completo continua funcionando', async () => {
    server = createServer((_req, res) => res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' }).end(gzipSync('<p>preço ok</p>')));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    expect(await fetchPage(`http://127.0.0.1:${port}/`, { allowedHosts: ['127.0.0.1'] })).toEqual({ ok: true, html: '<p>preço ok</p>' });
  });
});

describe('#3 isLoopbackAddress reconhece as formas de loopback, inclusive IPv4 mapeado', () => {
  it('127.x, ::1 e ::ffff:127.x (decimal ou hexadecimal) são loopback; o resto não', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['10.0.0.5', '::ffff:a00:5', '8.8.8.8', '169.254.169.254', '2606:4700::1111', '::', 'fe80::1']) expect(isLoopbackAddress(a), a).toBe(false);
  });
});

describe('#5 clique manual dentro da espera não grava falha nem conta para avisos', () => {
  const tracker: NewTracker = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none' };
  it('só devolve a mensagem de espera', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(tracker);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    const clock = new Date('2026-01-10T10:00:00Z').getTime();
    const now = () => new Date(clock);
    let searches = 0;
    const llm: LlmClient = { async search() { searches++; throw new Error('API fora do ar'); }, async chat() { throw new Error('x'); } };
    const fetchPage = async (): Promise<FetchResult> => ({ ok: false, kind: 'http', status: 404, message: '404' });
    const deps = { db, llm, notifier: new Notifier(db, transport, now), models: { routine: 'm', escalate: 'm2' }, now, fetchPage };
    await runCheck(deps, t.id, { manual: true }); // busca falha (1 verificação gravada)
    const before = db.listChecks(t.id).length;
    for (let i = 0; i < 5; i++) {
      const r = await runCheck(deps, t.id, { manual: true });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/aguarde/i);
    }
    expect(searches).toBe(1);
    expect(db.listChecks(t.id).length).toBe(before); // nada novo no histórico
    expect(sent).toEqual([]);
  });
});
