import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { classifyFinding, extractLinks } from '../src/service/trust';
import { decideAlert } from '../src/service/decide';
import { runCheck } from '../src/service/pipeline';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker } from '../src/shared/types';

const T = ['amazon.com.br', 'kabum.com.br'];
const ldPage = (price: number) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'PS5', offers: { '@type': 'Offer', price: String(price), priceCurrency: 'BRL', availability: 'https://schema.org/InStock' } })}</script></head><body>PS5</body></html>`;
const f = (over: Partial<Finding> = {}): Finding => ({ found: true, value: 3524, currency: 'BRL', title: 'x', sourceUrl: 'https://www.ofertinha.com.br/ps5', evidence: 'e', confidence: 0.9, ...over });
const never = async () => { throw new Error('não devia seguir link'); };

describe('extractLinks', () => {
  it('devolve links absolutos, sem fragmento, só http(s)', () => {
    const html = `<a href="/go/ps5#x">a</a><a href='https://www.amazon.com.br/dp/1?a=1&amp;b=2'>b</a><a href="javascript:void(0)">c</a><a href="mailto:a@b.c">d</a>`;
    expect(extractLinks(html, 'https://www.ofertinha.com.br/ps5')).toEqual([
      'https://www.ofertinha.com.br/go/ps5',
      'https://www.amazon.com.br/dp/1?a=1&b=2',
    ]);
  });
});

describe('#1 classifyFinding confere o link na PÁGINA do site desconhecido, não só no que a IA disse', () => {
  const AMZ = 'https://www.amazon.com.br/dp/PS5';
  it('store_url confiável que a página não tem: ignorada', async () => {
    const r = await classifyFinding(f({ storeUrl: AMZ }), T, never, async () => ['https://www.ofertinha.com.br/outra']);
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as { reason: string }).reason).toMatch(/não tem link para uma loja confiável/i);
  });
  it('store_url confiável e a página tem link para loja confiável: aceita via site', async () => {
    const r = await classifyFinding(f({ storeUrl: AMZ }), T, never, async () => [AMZ]);
    expect(r).toMatchObject({ verdict: 'via_trusted', via: 'ofertinha.com.br' });
  });
  it('página que não abre: ignorada com motivo', async () => {
    const r = await classifyFinding(f({ storeUrl: AMZ }), T, never, async () => undefined);
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as { reason: string }).reason).toMatch(/não consegui abrir/i);
  });
  it('link de saída que a página não contém: ignorada, sem seguir o link', async () => {
    const r = await classifyFinding(f({ storeUrl: 'https://www.ofertinha.com.br/go/ps5' }), T, never, async () => ['https://www.ofertinha.com.br/go/outro']);
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as { reason: string }).reason).toMatch(/não aparece na página/i);
  });
  it('link de saída presente na página e que termina em loja confiável: aceita', async () => {
    const go = 'https://www.ofertinha.com.br/go/ps5';
    const r = await classifyFinding(f({ storeUrl: go }), T, async () => ({ ok: true, finalUrl: AMZ }), async () => [go]);
    expect(r).toMatchObject({ verdict: 'via_trusted' });
  });
});

describe('alerta mostra o link da loja', () => {
  it('inclui o endereço da loja além do site onde foi achado', () => {
    const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: true } as never;
    const d = decideAlert(tracker, [f({ value: 3400, store: 'Amazon', storeUrl: 'https://www.amazon.com.br/dp/PS5', via: 'ofertinha.com.br' })], { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' });
    expect(d.alert!.text).toContain('Comprar: https://www.amazon.com.br/dp/PS5');
  });
});

describe('pipeline: limite de conferências, paralelo e cupom na rotina', () => {
  const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
  const REGEX = 'R\\$\\s*([\\d.,]+)';
  const base: NewTracker = {
    name: 'PS5 Slim', kind: 'price', goal: 'PS5 Slim digital', include: ['PS5'], exclude: [], intervalMinutes: 60,
    alertCondition: { type: 'below_last' }, digest: 'none', onlyTrusted: true,
  };
  const OFERTA = 'https://www.ofertinha.com.br/ps5';
  const GO = 'https://www.ofertinha.com.br/go/ps5';
  const AMZ = 'https://www.amazon.com.br/dp/PS5';
  const html = (p: string) => `<html><body><a href="${GO}">comprar</a><h1>Console PS5</h1><p>Por R$ ${p}</p></body></html>`;

  function setup(items: unknown[], pages: Record<string, string> = {}, resolve?: (u: string) => Promise<{ ok: true; finalUrl: string }>) {
    const db = openDb(':memory:');
    const t = db.createTracker(base);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    let clock = new Date('2026-01-10T10:00:00Z').getTime();
    const now = () => new Date(clock);
    const fetchPage = async (url: string): Promise<FetchResult> => (pages[url] ? { ok: true, html: pages[url] } : { ok: false, kind: 'http', status: 404, message: '404' });
    const llm: LlmClient = {
      async search(req) { return { text: JSON.stringify({ findings: items }), usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } }; },
      async chat() { throw new Error('x'); },
    };
    const notifier = new Notifier(db, transport, now);
    const resolveFinalUrl = resolve ?? (async (u: string) => ({ ok: true as const, finalUrl: u === GO ? AMZ : u }));
    return { db, t, sent, pages, advance: (min: number) => { clock += min * 60000; }, deps: { db, llm, notifier, models, now, fetchPage, resolveFinalUrl } };
  }

  it('fonte antiga de site desconhecido (aprendida antes da lista) não deixa a rotina muda: refaz a busca', async () => {
    const item = { found: true, value: 3600, currency: 'BRL', title: 'Amazon', source_url: AMZ, evidence: 'e', confidence: 0.9, price_regex: REGEX };
    const s = setup([item], { [AMZ]: html('3600,00') });
    s.db.upsertSource(s.t.id, { url: 'https://seletronic.com.br/ps5', label: 'Seletronic', status: 'ok', lastValue: 3905, rule: { type: 'regex', pattern: REGEX } });
    s.db.addCheck({ trackerId: s.t.id, at: '2026-01-10T09:00:00.000Z', ok: true, findings: [{ found: true, value: 3905, currency: 'BRL', title: 'Seletronic', sourceUrl: 'https://seletronic.com.br/ps5', evidence: 'e', confidence: 0.9 }], model: 'm', costUsd: 0, mode: 'discovery', sources: [] });
    s.advance(10); // descoberta feita há pouco: antes do conserto a rotina registrava leitura vazia sem buscar
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    const last = s.db.listChecks(s.t.id)[0];
    expect(last.mode).toBe('discovery');
    expect(last.findings.some((x) => x.sourceUrl === AMZ)).toBe(true);
  });

  it('#3 achados de loja confiável não gastam o limite de conferências: o 10º, o mais barato, ainda vale', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ found: true, value: 4000 - i * 10, currency: 'BRL', title: `Amazon ${i}`, source_url: `https://www.amazon.com.br/dp/${i}`, evidence: 'e', confidence: 0.9 }));
    const s = setup(items);
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted || r.baseline).toBe(true);
    const check = s.db.listChecks(s.t.id)[0];
    expect(check.findings.filter((x) => x.ignoredReason)).toHaveLength(0);
    expect(s.db.lastValue(s.t.id)).toBe(3910);
  });

  it('#5 as conferências de link rodam em paralelo (e o limite só vale para as que precisam de rede)', async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ found: true, value: 3500 + i, currency: 'BRL', title: `O${i}`, source_url: `https://blog${i}.com/ps5`, store: 'Amazon', store_url: `https://blog${i}.com/go`, evidence: 'e', confidence: 0.9 }));
    const pages: Record<string, string> = {};
    for (let i = 0; i < 4; i++) pages[`https://blog${i}.com/ps5`] = `<a href="https://blog${i}.com/go">x</a> R$ 3500`;
    pages[AMZ] = ldPage(3500);
    let inFlight = 0; let max = 0;
    const s = setup(items, pages, async (u) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      void u;
      return { ok: true, finalUrl: AMZ };
    });
    await runCheck(s.deps, s.t.id);
    expect(max).toBeGreaterThan(1);
    expect(s.db.listChecks(s.t.id)[0].findings.filter((x) => x.ignoredReason)).toHaveLength(0);
  });

  it('a 31ª oferta que precisa de rede passa da trava de segurança de 30 e fica ignorada com motivo', async () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ found: true, value: 3500 + i, currency: 'BRL', title: `O${i}`, source_url: `https://blog${i}.com/ps5`, store: 'Amazon', store_url: AMZ, evidence: 'e', confidence: 0.9 }));
    const pages: Record<string, string> = {};
    for (let i = 0; i < 31; i++) pages[`https://blog${i}.com/ps5`] = `<a href="${AMZ}">x</a> R$ 3500`;
    pages[AMZ] = ldPage(3500);
    const s = setup(items, pages);
    await runCheck(s.deps, s.t.id);
    const ignored = s.db.listChecks(s.t.id)[0].findings.filter((x) => x.ignoredReason);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].ignoredReason).toMatch(/limite/i);
  });

  it('#6 a rotina por código mantém loja, cupom e link da loja da oferta achada via site', async () => {
    const item = { found: true, value: 3524, currency: 'BRL', title: 'Ofertinha', source_url: OFERTA, store: 'Amazon', store_url: GO, coupon: 'PROMOAGORA (Pix)', evidence: 'e', confidence: 0.9, price_regex: REGEX };
    const s = setup([item], { [OFERTA]: html('3524,00'), [AMZ]: ldPage(3524) });
    await runCheck(s.deps, s.t.id); // descoberta: baseline (preço lido na Amazon)
    s.advance(65);
    s.pages[AMZ] = ldPage(3400);
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true);
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('routine');
    expect(s.sent.at(-1)).toContain('Cupom: PROMOAGORA (Pix)');
    expect(s.sent.at(-1)).toContain('Loja: Amazon');
    expect(s.sent.at(-1)).toContain(`Comprar: ${GO}`);
  });
});

describe('#2 banco antigo: acompanhamentos existentes continuam sem restrição', () => {
  it('migração põe only_trusted = 0 nos existentes; os novos nascem com 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-'));
    const file = join(dir, 'old.db');
    try {
      const old = new Database(file);
      old.exec(`CREATE TABLE trackers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL,
        include_json TEXT NOT NULL, exclude_json TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        alert_condition_json TEXT NOT NULL, digest TEXT NOT NULL DEFAULT 'none', status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL)`);
      old.prepare(`INSERT INTO trackers (name, kind, goal, include_json, exclude_json, interval_minutes, alert_condition_json, created_at) VALUES ('Velho','price','g','[]','[]',60,'{"type":"below_last"}','2026-01-01T00:00:00Z')`).run();
      old.close();
      const db = openDb(file);
      expect(db.listTrackers().find((t) => t.name === 'Velho')!.onlyTrusted).toBe(false);
      const novo = db.createTracker({ name: 'Novo', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' });
      expect(novo.onlyTrusted).toBe(true);
      db.raw.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* arquivo temporário ainda em uso: o sistema limpa depois */ }
    }
  });
});

describe('API: entradas inválidas são recusadas', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  async function api() {
    const db = openDb(':memory:');
    const deps: ApiDeps = {
      token: 't', db, now: () => new Date('2026-01-01T12:00:00Z'), hasApiKey: () => true, setApiKey: async () => undefined,
      whatsappStatus: () => ({ status: 'ready' }), newSetupSession: () => undefined, runCheckNow: async () => ({ ok: true, alerted: false, baseline: false }),
      buildId: 'b', shutdown: () => undefined, sendTestMessage: async () => ({ ok: true }),
    };
    server = createApi(deps);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, json: raw ? JSON.parse(raw) : undefined };
    };
    return { db, call };
  }
  const goodInput = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' };

  it('#4 sites confiáveis com entrada inválida: 400, e a lista guardada não muda', async () => {
    const { db, call } = await api();
    const bad = await call('PUT', '/settings', { trustedSites: ['amazon'] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/amazon/);
    const mixed = await call('PUT', '/settings', { trustedSites: ['kabum.com.br', 'https//x'] });
    expect(mixed.status).toBe(400);
    expect(db.getSetting('trusted_sites')).toBeUndefined();
    expect((await call('PUT', '/settings', { trustedSites: ['kabum.com.br', '  ', ''] })).json.trustedSites).toEqual(['kabum.com.br']);
  });

  it('#7 onlyTrusted precisa ser booleano no POST e no PATCH', async () => {
    const { call } = await api();
    expect((await call('POST', '/trackers', { ...goodInput, onlyTrusted: 'false' })).status).toBe(400);
    expect((await call('POST', '/trackers', { ...goodInput, onlyTrusted: 0 })).status).toBe(400);
    const created = await call('POST', '/trackers', goodInput);
    expect(created.status).toBe(201);
    expect((await call('PATCH', `/trackers/${created.json.id}`, { onlyTrusted: null })).status).toBe(400);
    expect((await call('PATCH', `/trackers/${created.json.id}`, { onlyTrusted: false })).json.onlyTrusted).toBe(false);
  });
});
