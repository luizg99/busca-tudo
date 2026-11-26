import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import { estimateCostUsd } from '../src/service/cost';
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
  const fetchPage = async (url: string): Promise<FetchResult> => {
    const p = pages[url];
    if (p === undefined) return { ok: false, kind: 'http', status: 404, message: 'O site respondeu com erro HTTP 404.' };
    return typeof p === 'string' ? { ok: true, html: p } : p;
  };

  const searchScript: string[] = [];
  const chatScript: string[] = [];
  let searchCalls = 0;
  let chatCalls = 0;
  const usage = { model: HAIKU, inputTokens: 500, outputTokens: 20, searches: 0 };
  const llm: LlmClient = {
    async search(req) {
      searchCalls++;
      const text = searchScript.shift();
      if (text === undefined) throw new Error('sem resposta de busca no script');
      return { text, usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } };
    },
    async chat(req) {
      chatCalls++;
      const text = chatScript.shift();
      if (text === undefined) throw new Error('sem resposta de chat no script');
      return { text, toolUses: [], content: [], usage: { ...usage, model: req.model } };
    },
  };
  const notifier = new Notifier(db, transport, now);
  const deps = { db, llm, notifier, models, now, fetchPage };
  return { db, t, sent, pages, searchScript, chatScript, advance, deps, calls: () => ({ search: searchCalls, chat: chatCalls }), usage };
}

describe('pipeline: descoberta, rotina por código e plano B', () => {
  it('1ª verificação: descoberta com busca completa; aprende a fonte com a regra da IA', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, baseline: true });
    expect(s.calls().search).toBe(1);
    const src = s.db.listSources(s.t.id);
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ url: 'https://l/a', label: 'Loja A', status: 'ok', rule: { type: 'regex' } });
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('discovery');
  });

  it('rotina seguinte: o código lê o preço, sem busca e sem IA, custo zero, e alerta se caiu', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(60);
    s.pages['https://l/a'] = page('3400,00');
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, alerted: true });
    expect(s.calls()).toEqual({ search: 1, chat: 0 });
    const check = s.db.listChecks(s.t.id)[0];
    expect(check).toMatchObject({ mode: 'routine', costUsd: 0 });
    expect(check.sources).toEqual([expect.objectContaining({ url: 'https://l/a', ok: true, method: 'rule', value: 3400 })]);
    expect(s.sent[0]).toContain('Menor achado: R$ 3.400,00');
    expect(s.sent[0]).toContain('Loja A');
    expect(s.sent[0]).toContain('Última consulta: R$ 3.524,00');
  });

  it('plano B: a página mudou (regra não casa) e a IA lê o trecho, com custo só de tokens', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(60);
    s.pages['https://l/a'] = '<html><body><p>Console PS5 Slim Digital agora por apenas R$ 3300,00 à vista</p></body></html>';
    s.chatScript.push('{"value": 3300}');
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, alerted: true });
    expect(s.calls()).toEqual({ search: 1, chat: 1 });
    const check = s.db.listChecks(s.t.id)[0];
    expect(check.mode).toBe('routine');
    expect(check.sources[0]).toMatchObject({ ok: true, method: 'ai', value: 3300 });
    expect(check.costUsd).toBeCloseTo(estimateCostUsd({ model: HAIKU, inputTokens: 500, outputTokens: 20, searches: 0 }), 8);
    expect(check.costUsd).toBeGreaterThan(0);
  });

  it('se nenhuma fonte der preço (A e B falharam), cai na busca completa (fallback) e registra a falha da fonte', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(7 * 60); // a busca de reserva só roda se a última busca completa foi há mais de 6 h
    s.pages['https://l/a'] = blocked;
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }]));
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    expect(s.calls().search).toBe(2);
    const check = s.db.listChecks(s.t.id)[0];
    expect(check.mode).toBe('fallback');
    expect(check.sources[0]).toMatchObject({ ok: false, error: expect.stringContaining('bloqueou') });
    const src = s.db.listSources(s.t.id)[0];
    expect(src).toMatchObject({ status: 'failing', consecutiveFailures: 1 }); // a busca não rebaixa uma fonte boa para "ilegível"
    expect(s.sent.filter((m) => m.includes('não consegui ler'))).toEqual([]); // 1ª falha: ainda sem aviso de site
  });

  it('descoberta volta a rodar depois de 24 h, mesmo com a rotina funcionando', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(25 * 60);
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    expect(s.calls().search).toBe(2);
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('discovery');
  });

  it('acompanhamento de notícias não usa fontes: sempre busca completa', async () => {
    const s = setup({ ...priceTracker, kind: 'news', alertCondition: { type: 'new_items' } });
    const news = JSON.stringify({ findings: [{ found: true, title: 'N1', source_url: 'https://n/1', evidence: 'e', confidence: 0.9 }] });
    s.searchScript.push(news, news);
    await runCheck(s.deps, s.t.id); s.advance(60); await runCheck(s.deps, s.t.id);
    expect(s.calls().search).toBe(2);
    expect(s.db.listSources(s.t.id)).toHaveLength(0);
  });
});

describe('pipeline: falhas de site e aviso no WhatsApp', () => {
  async function twoSources() {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.pages['https://l/b'] = page('3600,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }, { url: 'https://l/b', value: 3600, label: 'Loja B' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(60);
    return s;
  }

  it('um site falha e outro funciona: segue em rotina (sem busca); avisa só na 2ª falha seguida, e só daquele site', async () => {
    const s = await twoSources();
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id);
    expect(s.calls().search).toBe(1); // não precisou da busca
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('routine');
    expect(s.sent).toEqual([]);
    s.advance(60);
    await runCheck(s.deps, s.t.id);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('Loja B');
    expect(s.sent[0]).toContain('bloqueou');
    expect(s.sent[0]).not.toContain('Loja A:');
    expect(s.sent[0]).toMatch(/busca completa/);
  });

  it('não repete o aviso do mesmo site enquanto o problema continua; só lembra depois de 7 dias', async () => {
    const s = await twoSources();
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id); s.advance(60); // aviso aqui
    s.pages['https://l/a'] = page('3524,00');
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id);
    const siteWarnings = () => s.sent.filter((m) => m.includes('não consegui ler'));
    expect(siteWarnings()).toHaveLength(1);
    s.advance(24 * 60); // um dia depois: continua sem repetir
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    expect(siteWarnings()).toHaveLength(1);
    s.advance(7 * 24 * 60); // passou a semana: lembrete
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    expect(siteWarnings()).toHaveLength(2);
  });

  it('o aviso de site com problema não conta como alerta de preço (nem aparece como queda)', async () => {
    const s = await twoSources();
    s.pages['https://l/b'] = blocked;
    await runCheck(s.deps, s.t.id); s.advance(60);
    await runCheck(s.deps, s.t.id);
    expect(s.sent).toHaveLength(1);
    expect(s.db.pendingAlerts()).toHaveLength(0);
    expect(s.db.lastAlert(s.t.id)).toBeUndefined();
  });

  it('site cujo preço não está no HTML (JavaScript) vira "unreadable" e é avisado uma vez, na descoberta', async () => {
    const s = setup();
    s.pages['https://l/js'] = JS_ONLY;
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }, { url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(s.deps, s.t.id);
    const js = s.db.listSources(s.t.id).find((x) => x.url === 'https://l/js')!;
    expect(js.status).toBe('unreadable');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('Loja JS');
    expect(s.sent[0]).toMatch(/JavaScript/);
    // a rotina ignora o site ilegível (não conta falha) e não repete o aviso
    s.advance(60);
    await runCheck(s.deps, s.t.id);
    expect(s.sent).toHaveLength(1);
    expect(s.db.getSource(js.id)!.consecutiveFailures).toBe(0);
  });

  it('se o WhatsApp não entregar o aviso, ele é tentado de novo na verificação seguinte', async () => {
    const s = setup();
    let ready = false;
    const delivered: string[] = [];
    const transport: Transport = { isReady: () => ready, async sendToSelf(x) { delivered.push(x); } };
    const notifier = new Notifier(s.db, transport, s.deps.now);
    const deps = { ...s.deps, notifier };
    s.pages['https://l/js'] = JS_ONLY;
    s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(deps, s.t.id);
    expect(delivered).toHaveLength(0);
    ready = true;
    s.advance(60);
    s.searchScript.push(discoveryJson([{ url: 'https://l/js', value: 3524, label: 'Loja JS' }]));
    await runCheck(deps, s.t.id);
    expect(delivered).toHaveLength(1);
  });
});
