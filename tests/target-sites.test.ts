import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_TARGET_SITES, MIN_TARGET_SITES, MAX_TARGET_SITES, getTargetSites, searchBudget } from '../src/service/target';
import { runSmartCheck } from '../src/service/checker';
import { runCheck } from '../src/service/pipeline';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { NewTracker, Tracker } from '../src/shared/types';

const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
const mk = (kind: 'price' | 'news'): Tracker => ({ id: 1, name: 'PS5', kind, goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: false } as Tracker);

describe('meta de sites por busca', () => {
  it('padrão 15, entre 3 e 30; valor inválido volta ao padrão', () => {
    expect([DEFAULT_TARGET_SITES, MIN_TARGET_SITES, MAX_TARGET_SITES]).toEqual([15, 3, 30]);
    const db = openDb(':memory:');
    expect(getTargetSites(db)).toBe(15);
    db.setSetting('target_sites', '20');
    expect(getTargetSites(db)).toBe(20);
    for (const bad of ['2', '31', 'x', '', '12.5']) { db.setSetting('target_sites', bad); expect(getTargetSites(db)).toBe(15); }
  });

  it('o número de pesquisas na web cresce com a meta (15 sites → 10 pesquisas), com mínimo 4 e teto 12', () => {
    expect(searchBudget(15)).toBe(10);
    expect(searchBudget(3)).toBe(4);
    expect(searchBudget(8)).toBe(6);
    expect(searchBudget(30)).toBe(12);
  });
});

describe('a busca recebe a meta e o limite de pesquisas', () => {
  async function run(t: Tracker, opts: { targetSites?: number }) {
    const seen: { prompt?: string; maxSearches?: number } = {};
    const llm: LlmClient = {
      async search(req) { seen.prompt = req.prompt; seen.maxSearches = req.maxSearches; return { text: '{"findings":[{"found":false,"evidence":"x","confidence":0.9}]}', usage }; },
      async chat() { throw new Error('x'); },
    };
    await runSmartCheck(llm, t, { routine: 'r', escalate: 'e' }, opts);
    return seen;
  }

  it('preço: pede cerca de 15 ofertas de sites diferentes e libera 10 pesquisas', async () => {
    const s = await run(mk('price'), { targetSites: 15 });
    expect(s.prompt).toMatch(/cerca de 15 ofertas/i);
    expect(s.prompt).toMatch(/sites ou lojas diferentes/i);
    expect(s.maxSearches).toBe(10);
  });

  it('sem meta informada usa o padrão; com meta 8 pede 8 e libera 6', async () => {
    expect((await run(mk('price'), {})).prompt).toMatch(/cerca de 15 ofertas/i);
    const s = await run(mk('price'), { targetSites: 8 });
    expect(s.prompt).toMatch(/cerca de 8 ofertas/i);
    expect(s.maxSearches).toBe(6);
  });

  it('notícias não recebem meta de sites e seguem com o limite padrão de pesquisas', async () => {
    const s = await run(mk('news'), { targetSites: 15 });
    expect(s.prompt).not.toMatch(/cerca de 15 ofertas/i);
    expect(s.maxSearches).toBeUndefined();
  });
});

describe('pipeline usa a meta configurada', () => {
  it('a busca completa recebe a meta guardada nas configurações', async () => {
    const base: NewTracker = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none', onlyTrusted: false };
    const db = openDb(':memory:');
    const t = db.createTracker(base);
    db.setSetting('target_sites', '20');
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    const now = () => new Date('2026-01-10T10:00:00Z');
    let seen: { prompt?: string; maxSearches?: number } = {};
    const llm: LlmClient = {
      async search(req) { seen = { prompt: req.prompt, maxSearches: req.maxSearches }; return { text: '{"findings":[{"found":false,"evidence":"x","confidence":0.9}]}', usage }; },
      async chat() { throw new Error('x'); },
    };
    await runCheck({ db, llm, notifier: new Notifier(db, transport, now), models: { routine: 'r', escalate: 'e' }, now, fetchPage: async () => ({ ok: false, kind: 'http', status: 404, message: '404' }) }, t.id);
    expect(seen.prompt).toMatch(/cerca de 20 ofertas/i);
    expect(seen.maxSearches).toBe(12);
  });
});

describe('API: configuração "sites por busca"', () => {
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
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
  }

  it('GET traz 15; PUT valida entre 3 e 30 (inteiro) e guarda', async () => {
    const call = await api();
    expect((await call('GET', '/settings')).json.targetSites).toBe(15);
    expect((await call('PUT', '/settings', { targetSites: 12 })).json.targetSites).toBe(12);
    expect((await call('GET', '/settings')).json.targetSites).toBe(12);
    for (const bad of [2, 31, 'x', 12.5, null]) expect((await call('PUT', '/settings', { targetSites: bad })).status).toBe(400);
    expect((await call('GET', '/settings')).json.targetSites).toBe(12);
  });
});
