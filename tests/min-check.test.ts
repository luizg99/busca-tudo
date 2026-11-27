import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/service/db';
import { computeStats } from '../src/service/reports';
import { createApi, type ApiDeps } from '../src/service/api';
import type { Finding } from '../src/shared/types';

const find = (value: number): Finding => ({ found: true, value, currency: 'BRL', title: 't', sourceUrl: 'https://www.amazon.com.br/dp/x', evidence: 'e', confidence: 0.9 });

function seed() {
  const db = openDb(':memory:');
  const t = db.createTracker({ name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' });
  const add = (at: string, v: number | undefined, ok = true) =>
    db.addCheck({ trackerId: t.id, at, ok, findings: v === undefined ? [] : [find(v)], model: 'm', costUsd: 0, mode: 'routine' });
  return { db, t, add };
}

describe('estatística guarda a consulta do menor preço', () => {
  it('minCheckId/minAt apontam para a 1ª consulta que achou o menor valor', () => {
    const { db, t, add } = seed();
    add('2026-01-10T10:00:00.000Z', 4000);
    const low = add('2026-01-10T11:00:00.000Z', 3524);
    add('2026-01-10T12:00:00.000Z', 3524); // empate: vale a primeira
    add('2026-01-10T13:00:00.000Z', 3900);
    const s = computeStats(db, t.id, '2026-01-09T00:00:00.000Z', '2026-01-11T00:00:00.000Z');
    expect(s.min).toBe(3524);
    expect(s.minCheckId).toBe(low);
    expect(s.minAt).toBe('2026-01-10T11:00:00.000Z');
  });

  it('sem preço no período, não há minCheckId', () => {
    const { db, t, add } = seed();
    add('2026-01-10T10:00:00.000Z', undefined);
    const s = computeStats(db, t.id, '2026-01-09T00:00:00.000Z', '2026-01-11T00:00:00.000Z');
    expect(s.min).toBeUndefined();
    expect(s.minCheckId).toBeUndefined();
  });
});

describe('API: GET /trackers/:id/checks/:checkId', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  async function api(db: ReturnType<typeof openDb>) {
    const deps: ApiDeps = {
      token: 't', db, now: () => new Date('2026-01-11T00:00:00Z'), hasApiKey: () => true, setApiKey: async () => undefined,
      whatsappStatus: () => ({ status: 'ready' }), newSetupSession: () => undefined, runCheckNow: async () => ({ ok: true, alerted: false, baseline: false }),
      buildId: 'b', shutdown: () => undefined, sendTestMessage: async () => ({ ok: true }),
    };
    server = createApi(deps);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string) => {
      const res = await fetch(base + path, { headers: { authorization: 'Bearer t' } });
      const raw = await res.text();
      return { status: res.status, json: raw ? JSON.parse(raw) : undefined };
    };
  }

  it('devolve a consulta; 404 se não existe ou é de outro acompanhamento', async () => {
    const { db, t, add } = seed();
    const other = db.createTracker({ name: 'Outro', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' });
    const id = add('2026-01-10T11:00:00.000Z', 3524);
    const get = await api(db);
    const ok = await get(`/trackers/${t.id}/checks/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.json.id).toBe(id);
    expect(ok.json.findings[0].value).toBe(3524);
    expect((await get(`/trackers/${other.id}/checks/${id}`)).status).toBe(404);
    expect((await get(`/trackers/${t.id}/checks/99999`)).status).toBe(404);
  });
});

describe('API: GET /trackers/:id/last-search (última busca completa com IA)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  async function api(db: ReturnType<typeof openDb>) {
    const deps: ApiDeps = {
      token: 't', db, now: () => new Date('2026-01-11T00:00:00Z'), hasApiKey: () => true, setApiKey: async () => undefined,
      whatsappStatus: () => ({ status: 'ready' }), newSetupSession: () => undefined, runCheckNow: async () => ({ ok: true, alerted: false, baseline: false }),
      buildId: 'b', shutdown: () => undefined, sendTestMessage: async () => ({ ok: true }),
    };
    server = createApi(deps);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string) => {
      const res = await fetch(base + path, { headers: { authorization: 'Bearer t' } });
      return { status: res.status, json: await res.json() };
    };
  }
  const offer = (url: string, extra: Partial<Finding> = {}): Finding => ({ found: true, value: 3500, currency: 'BRL', title: 't', sourceUrl: url, evidence: 'e', confidence: 0.9, ...extra });

  it('traz quando rodou, qual consulta é e quantos sites achou (sem contar o mesmo site duas vezes)', async () => {
    const { db, t } = seed();
    db.addCheck({ trackerId: t.id, at: '2026-01-09T10:00:00.000Z', ok: true, findings: [offer('https://a.com/x')], model: 'm', costUsd: 0.05, mode: 'discovery' });
    const id = db.addCheck({
      trackerId: t.id, at: '2026-01-10T10:00:00.000Z', ok: true, model: 'm', costUsd: 0.05, mode: 'discovery',
      findings: [offer('https://a.com/x'), offer('https://www.a.com/x?ref=1'), offer('https://b.com/y'), offer('https://c.com/z', { ignoredReason: 'loja desconhecida' }), { found: false, evidence: 'nada', confidence: 0.9 }],
    });
    db.addCheck({ trackerId: t.id, at: '2026-01-10T12:00:00.000Z', ok: true, findings: [offer('https://a.com/x')], model: 'm', costUsd: 0, mode: 'routine' }); // rotina não conta
    db.addCheck({ trackerId: t.id, at: '2026-01-10T13:00:00.000Z', ok: false, error: 'falhou', findings: [], model: 'm', costUsd: 0, mode: 'discovery' }); // falha não conta
    const get = await api(db);
    const r = await get(`/trackers/${t.id}/last-search`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ at: '2026-01-10T10:00:00.000Z', checkId: id, sites: 3, ignored: 1, mode: 'discovery' });
  });

  it('sem nenhuma busca completa ainda: objeto vazio', async () => {
    const { db, t, add } = seed();
    add('2026-01-10T10:00:00.000Z', 3500);
    const get = await api(db);
    expect((await get(`/trackers/${t.id}/last-search`)).json).toEqual({});
  });
});
