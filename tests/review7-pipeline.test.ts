import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { runCheck } from '../src/service/pipeline';
import { generateDigest } from '../src/service/reports';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { FetchResult } from '../src/service/fetcher';
import type { NewTracker } from '../src/shared/types';

const HAIKU = 'claude-haiku-5-5';
const models = { routine: HAIKU, escalate: 'claude-sonnet-5-5' };
const priceTracker: NewTracker = {
  name: 'PS5 Slim Digital', kind: 'price', goal: 'Preço do PS5 Slim digital novo', include: ['PS5 Slim Digital'], exclude: ['usado'],
  intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'daily',
  onlyTrusted: false, // estes testes usam lojas de mentira; a lista de confiáveis é testada em trusted.test.ts
};
const REGEX = 'Digital.{0,30}?R\\$\\s*([\\d.,]+)\\s*no pix';
const page = (price: string) => `<html><body><h1>Console PS5 Slim Digital</h1><p>Por R$ ${price} no pix</p></body></html>`;
const blocked: FetchResult = { ok: false, kind: 'blocked', status: 429, message: 'O site bloqueou o acesso automático (HTTP 429).' };
const JS_ONLY = '<html><body><div id="app"></div><script>window.__DATA__={"preco":3524}</script></body></html>';
type Item = { url: string; value: number; label: string };
const discoveryJson = (items: Item[]) =>
  JSON.stringify({ findings: items.map((i) => ({ found: true, value: i.value, currency: 'BRL', title: i.label, source_url: i.url, evidence: 'e', confidence: 0.9, price_regex: REGEX })) });

function setup(tracker: NewTracker = priceTracker) {
  const db = openDb(':memory:');
  const t = db.createTracker(tracker);
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  let clock = new Date('2026-01-10T10:00:00Z').getTime();
  const now = () => new Date(clock);
  const advance = (min: number) => { clock += min * 60000; };
  const pages: Record<string, FetchResult | string> = {};
  let fetchOverride: ((url: string) => Promise<FetchResult>) | undefined;
  const fetchPage = async (url: string): Promise<FetchResult> => {
    if (fetchOverride) return fetchOverride(url);
    const p = pages[url];
    if (p === undefined) return { ok: false, kind: 'http', status: 404, message: 'O site respondeu com erro HTTP 404.' };
    return typeof p === 'string' ? { ok: true, html: p } : p;
  };
  const searchScript: Array<string | Error> = [];
  let searchCalls = 0;
  let chatText = '{"value": null}';
  const llm: LlmClient = {
    async search(req) {
      searchCalls++;
      const next = searchScript.shift();
      if (next === undefined) throw new Error('sem resposta de busca no script');
      if (next instanceof Error) throw next;
      return { text: next, usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } };
    },
    async chat(req) { return { text: chatText, toolUses: [], content: [], usage: { model: req.model, inputTokens: 300, outputTokens: 10, searches: 0 } }; },
  };
  const notifier = new Notifier(db, transport, now);
  return {
    db, t, sent, pages, searchScript, advance, now, notifier, llm,
    deps: { db, llm, notifier, models, now, fetchPage },
    searches: () => searchCalls, setChat: (x: string) => { chatText = x; }, setFetch: (f: (url: string) => Promise<FetchResult>) => { fetchOverride = f; },
  };
}

async function twoSources() {
  const s = setup();
  s.pages['https://l/a'] = page('3500,00');
  s.pages['https://l/b'] = page('3600,00');
  s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }, { url: 'https://l/b', value: 3600, label: 'Loja B' }]));
  await runCheck(s.deps, s.t.id);
  s.advance(60);
  return s;
}

describe('#1 falha passageira de uma loja não gera alerta falso', () => {
  it('A falha num check e volta igual no seguinte: sem "achei um preço menor"', async () => {
    const s = await twoSources();
    s.pages['https://l/a'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60); // só B (3600) lida
    s.pages['https://l/a'] = page('3500,00');
    const r = await runCheck(s.deps, s.t.id); // A volta, igual ao que era
    expect(r.alerted).toBe(false);
    expect(s.sent.filter((m) => m.includes('menor que na última consulta'))).toEqual([]);
  });
  it('uma queda real de A continua alertando, comparada com o menor valor conhecido', async () => {
    const s = await twoSources();
    s.pages['https://l/a'] = page('3400,00');
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true);
    expect(s.sent[0]).toContain('Última consulta: R$ 3.500,00');
  });
});

describe('#3 queda grande é confirmada pela busca completa, sem virar falha da loja', () => {
  it('A cai de 3500 para 1500: a rotina marca suspeito, a busca confirma e o alerta sai', async () => {
    const s = await twoSources();
    s.pages['https://l/a'] = page('1500,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 1500, label: 'Loja A' }, { url: 'https://l/b', value: 3600, label: 'Loja B' }]));
    s.advance(1); // 61 min depois da descoberta
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, alerted: true });
    expect(s.searches()).toBe(2);
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('fallback');
    expect(s.sent[0]).toContain('Menor achado: R$ 1.500,00');
    const a = s.db.listSources(s.t.id).find((x) => x.url === 'https://l/a')!;
    expect(a.consecutiveFailures).toBe(0);
    expect(s.sent.filter((m) => m.includes('não consegui ler'))).toEqual([]);
  });
  it('se a busca não confirma, nenhum alerta sai e a loja não conta como falhando', async () => {
    const s = await twoSources();
    s.pages['https://l/a'] = page('1500,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }, { url: 'https://l/b', value: 3600, label: 'Loja B' }]));
    s.advance(1);
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(false);
    const a = s.db.listSources(s.t.id).find((x) => x.url === 'https://l/a')!;
    expect(a.consecutiveFailures).toBe(0);
  });
});

describe('#8 erro no aprendizado não perde o check nem o custo', () => {
  it('fetchPage que lança durante learnSources: o check é gravado com custo e a busca não se repete', async () => {
    const s = setup();
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }]));
    s.setFetch(async () => { throw new Error('boom inesperado'); });
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    const checks = s.db.listChecks(s.t.id);
    expect(checks).toHaveLength(1);
    expect(checks[0].costUsd).toBeGreaterThan(0);
    expect(s.db.lastDiscoveryAt(s.t.id)).toBeDefined();
  });
});

describe('#10 só fontes ilegíveis: busca completa no máximo 1 vez por dia', () => {
  it('JS-only como única fonte: checks seguintes não repetem a busca e não são falha', async () => {
    const s = setup();
    s.pages['https://l/js'] = JS_ONLY;
    s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(s.deps, s.t.id);
    for (let i = 0; i < 3; i++) {
      s.advance(60);
      const r = await runCheck(s.deps, s.t.id);
      expect(r.ok).toBe(true);
    }
    expect(s.searches()).toBe(1);
    expect(s.db.listChecks(s.t.id)[0]).toMatchObject({ ok: true, costUsd: 0, mode: 'routine' });
    s.advance(24 * 60);
    s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(2);
  });
});

describe('#9 falha passageira ao aprender: rotina tenta de novo, sem aviso', () => {
  it('timeout no aprendizado → fonte "failing"; no check seguinte a página responde e o plano B lê', async () => {
    const s = setup();
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }]));
    s.pages['https://l/a'] = { ok: false, kind: 'timeout', message: 'O site demorou mais de 15 s para responder.' };
    await runCheck(s.deps, s.t.id);
    expect(s.sent).toEqual([]);
    expect(s.db.listSources(s.t.id)[0].status).toBe('failing');
    s.advance(60);
    s.pages['https://l/a'] = page('3500,00');
    s.setChat('{"value": 3500}');
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    expect(s.db.listChecks(s.t.id)[0].sources[0]).toMatchObject({ ok: true, method: 'ai', value: 3500 });
    expect(s.db.listSources(s.t.id)[0]).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });
});

describe('#11 avisos de site: um por episódio (lembrete só depois de 7 dias)', () => {
  it('site ilegível avisa uma única vez, mesmo passando dias', async () => {
    const s = setup();
    s.pages['https://l/js'] = JS_ONLY;
    s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(s.deps, s.t.id);
    expect(s.sent.filter((m) => m.includes('não consegui ler'))).toHaveLength(1);
    for (let d = 0; d < 5; d++) {
      s.advance(24 * 60 + 5);
      s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
      await runCheck(s.deps, s.t.id);
    }
    expect(s.sent.filter((m) => m.includes('não consegui ler'))).toHaveLength(1);
  });
  it('site que volta a funcionar e falha de novo é um episódio novo e avisa de novo', async () => {
    const s = await twoSources();
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id); s.advance(60); // 2ª falha: aviso 1
    expect(s.sent.filter((m) => m.includes('Loja B'))).toHaveLength(1);
    s.pages['https://l/b'] = page('3600,00');
    await runCheck(s.deps, s.t.id); s.advance(60); // voltou
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id); // novo episódio: aviso 2
    expect(s.sent.filter((m) => m.includes('Loja B'))).toHaveLength(2);
  });
  it('falha que continua por mais de 7 dias ganha um lembrete', async () => {
    const s = await twoSources();
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id); // aviso 1
    s.advance(3 * 24 * 60);
    await runCheck(s.deps, s.t.id);
    expect(s.sent.filter((m) => m.includes('Loja B'))).toHaveLength(1);
    s.advance(5 * 24 * 60);
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    expect(s.sent.filter((m) => m.includes('Loja B'))).toHaveLength(2);
  });
});

describe('#11 resumo: só problemas novos e só acompanhamentos ativos', () => {
  const NOW = new Date('2026-03-10T12:00:00Z');
  function digestSetup() {
    const db = openDb(':memory:');
    const t = db.createTracker(priceTracker);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    const notifier = new Notifier(db, transport, () => NOW);
    const llm: LlmClient = { async search() { throw new Error('x'); }, async chat() { throw new Error('não deve chamar a IA'); } };
    const deps = { db, llm, notifier, model: HAIKU, sendWhatsApp: true, now: () => NOW };
    const age = (id: number, createdAt: string, failingSince?: string) =>
      db.raw.prepare('UPDATE sources SET created_at = ?, failing_since = ? WHERE id = ?').run(createdAt, failingSince ?? null, id);
    return { db, t, sent, deps, age };
  }
  it('problema antigo (criado e falhando há mais que o período) não entra de novo no resumo', async () => {
    const s = digestSetup();
    const a = s.db.upsertSource(s.t.id, { url: 'https://js', label: 'JS', status: 'unreadable', lastError: 'JavaScript' });
    const b = s.db.upsertSource(s.t.id, { url: 'https://b', label: 'B', status: 'ok' });
    s.db.recordSourceResult(b.id, { ok: false, error: 'bloqueou', at: '2026-02-01T10:00:00Z' });
    s.age(a.id, '2026-02-01T10:00:00Z');
    s.age(b.id, '2026-02-01T10:00:00Z', '2026-02-01T10:00:00Z');
    expect((await generateDigest(s.deps, 'daily')).sent).toBe(false);
  });
  it('problema novo (descoberto ou começou a falhar dentro do período) entra', async () => {
    const s = digestSetup();
    const a = s.db.upsertSource(s.t.id, { url: 'https://js', label: 'JS', status: 'unreadable', lastError: 'JavaScript' });
    s.age(a.id, '2026-03-10T03:00:00Z');
    const r = await generateDigest(s.deps, 'daily');
    expect(r.sent).toBe(true);
    expect(r.text).toContain('JS');
  });
  it('acompanhamento pausado não entra', async () => {
    const s = digestSetup();
    const a = s.db.upsertSource(s.t.id, { url: 'https://js', label: 'JS', status: 'unreadable', lastError: 'JavaScript' });
    s.age(a.id, '2026-03-10T03:00:00Z');
    s.db.updateTracker(s.t.id, { status: 'paused' });
    expect((await generateDigest(s.deps, 'daily')).sent).toBe(false);
  });
});

describe('#2 editar o acompanhamento apaga as fontes aprendidas', () => {
  let server: Server | undefined;
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
  async function withSource() {
    const { db, call } = await api();
    const t = db.createTracker(priceTracker);
    db.upsertSource(t.id, { url: 'https://l/a', label: 'A', status: 'ok', lastValue: 3500 });
    return { db, call, id: t.id };
  }
  it('mudar nome, objetivo, considerar, ignorar ou tipo apaga as fontes', async () => {
    for (const patch of [{ name: 'Geladeira' }, { goal: 'Preço de uma geladeira' }, { include: ['frost free'] }, { exclude: ['usada'] }, { kind: 'generic' }]) {
      const { db, call, id } = await withSource();
      expect((await call('PATCH', `/trackers/${id}`, patch)).status, JSON.stringify(patch)).toBe(200);
      expect(db.listSources(id), JSON.stringify(patch)).toHaveLength(0);
      await new Promise<void>((r) => server!.close(() => r()));
    }
  });
  it('pausar, mudar frequência, condição de alerta ou resumo NÃO apaga as fontes', async () => {
    for (const patch of [{ status: 'paused' }, { intervalMinutes: 120 }, { alertCondition: { type: 'below_value', value: 3000 } }, { digest: 'weekly' }, { name: priceTracker.name }]) {
      const { db, call, id } = await withSource();
      expect((await call('PATCH', `/trackers/${id}`, patch)).status, JSON.stringify(patch)).toBe(200);
      expect(db.listSources(id), JSON.stringify(patch)).toHaveLength(1);
      await new Promise<void>((r) => server!.close(() => r()));
    }
  });
});
