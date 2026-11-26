import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';
import { SetupSession } from '../src/service/setupChat';
import type { ChatReply, LlmClient } from '../src/service/llm';

const TOKEN = 'tok-123';
const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
const goodInput = {
  name: 'PS5', kind: 'price', goal: 'menor preço', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'none',
};
const toolReply: ChatReply = {
  text: '', toolUses: [{ id: 't1', name: 'create_tracker', input: goodInput }],
  content: [{ type: 'tool_use', id: 't1', name: 'create_tracker', input: goodInput }], usage,
};
const textReply = (t: string): ChatReply => ({ text: t, toolUses: [], content: [{ type: 'text', text: t }], usage });

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(over: Partial<ApiDeps> = {}) {
  const db = openDb(':memory:');
  const replies = [toolReply, textReply('Confira o resumo.')];
  const llm: LlmClient = { async search() { throw new Error('x'); }, async chat() { return replies.shift() ?? textReply('ok'); } };
  let apiKey: string | undefined;
  const deps: ApiDeps = {
    token: TOKEN, db, now: () => new Date('2026-01-01T12:00:00Z'),
    hasApiKey: () => !!apiKey,
    setApiKey: async (k) => { apiKey = k; },
    whatsappStatus: () => ({ status: 'disconnected' }),
    newSetupSession: () => new SetupSession(llm, 'm'),
    runCheckNow: async () => ({ ok: true, alerted: false, baseline: true }),
    ...over,
  };
  server = createApi(deps);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, json: raw ? JSON.parse(raw) : undefined };
  };
  return { call, db };
}

describe('api', () => {
  it('sem token ou com token errado devolve 401', async () => {
    const { call } = await start();
    expect((await call('GET', '/status', undefined, null)).status).toBe(401);
    expect((await call('GET', '/status', undefined, 'errado')).status).toBe(401);
  });

  it('POST /trackers com intervalo < 15 devolve 400 com a mensagem', async () => {
    const { call } = await start();
    const r = await call('POST', '/trackers', { ...goodInput, intervalMinutes: 5 });
    expect(r.status).toBe(400);
    expect(r.raw).toContain('15');
  });

  it('POST /trackers válido cria e aparece em GET /trackers; PATCH pausa; DELETE remove', async () => {
    const { call } = await start();
    const created = await call('POST', '/trackers', goodInput);
    expect(created.status).toBe(201);
    const id = created.json.id;
    expect((await call('GET', '/trackers')).json).toHaveLength(1);
    expect((await call('PATCH', `/trackers/${id}`, { status: 'paused' })).json.status).toBe('paused');
    expect((await call('DELETE', `/trackers/${id}`)).status).toBe(204);
    expect((await call('GET', '/trackers')).json).toHaveLength(0);
  });

  it('confirm sem proposta pendente devolve 409', async () => {
    const { call } = await start();
    expect((await call('POST', '/setup/s1/confirm')).status).toBe(409);
  });

  it('fluxo message -> confirm cria o acompanhamento', async () => {
    const { call } = await start();
    const m = await call('POST', '/setup/s1/message', { text: 'quero acompanhar o ps5' });
    expect(m.status).toBe(200);
    expect(m.json.proposal.name).toBe('PS5');
    const c = await call('POST', '/setup/s1/confirm');
    expect(c.status).toBe(201);
    expect((await call('GET', '/trackers')).json.map((t: any) => t.name)).toEqual(['PS5']);
    expect((await call('POST', '/setup/s1/confirm')).status).toBe(409);
  });

  it('setup sem chave da Anthropic devolve 409 com mensagem clara', async () => {
    const { call } = await start({ newSetupSession: () => undefined });
    const r = await call('POST', '/setup/s1/message', { text: 'oi' });
    expect(r.status).toBe(409);
    expect(r.raw).toContain('chave');
  });

  it('GET /status informa hasApiKey false sem chave', async () => {
    const { call } = await start();
    const r = await call('GET', '/status');
    expect(r.json).toMatchObject({ running: true, hasApiKey: false, whatsapp: 'disconnected', overLimit: false });
  });

  it('PUT /settings guarda a chave e nunca a devolve em nenhuma resposta', async () => {
    const { call } = await start();
    const secret = 'sk-ant-SEGREDO-999';
    const put = await call('PUT', '/settings', { anthropicApiKey: secret, limitDayUsd: 2 });
    expect(put.status).toBe(200);
    for (const [m, p] of [['GET', '/settings'], ['GET', '/status']] as const) {
      expect((await call(m, p)).raw).not.toContain(secret);
    }
    expect(put.raw).not.toContain(secret);
    expect((await call('GET', '/status')).json.hasApiKey).toBe(true);
    expect((await call('GET', '/settings')).json.limitDayUsd).toBe(2);
  });

  it('POST /trackers/:id/check executa a verificação agora', async () => {
    const { call } = await start();
    const id = (await call('POST', '/trackers', goodInput)).json.id;
    const r = await call('POST', `/trackers/${id}/check`);
    expect(r.json).toMatchObject({ ok: true, baseline: true });
  });

  it('JSON inválido devolve 400', async () => {
    const { call } = await start();
    const res = await fetch((server!.address() as AddressInfo).port ? `http://127.0.0.1:${(server!.address() as AddressInfo).port}/trackers` : '', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{nao-json',
    });
    expect(res.status).toBe(400);
    expect(call).toBeDefined();
  });
});
