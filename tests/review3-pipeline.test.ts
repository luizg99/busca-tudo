import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { FetchResult } from '../src/service/fetcher';
import type { NewTracker } from '../src/shared/types';

const HAIKU = 'claude-haiku-5-5';
const models = { routine: HAIKU, escalate: 'claude-sonnet-5-5' };
const priceTracker: NewTracker = {
  name: 'PS5 Slim Digital', kind: 'price', goal: 'Preço do PS5 Slim digital novo', include: ['PS5 Slim Digital'], exclude: ['usado'],
  intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'daily',
};
const REGEX = 'Digital.{0,30}?R\\$\\s*([\\d.,]+)\\s*no pix';
const page = (price: string) => `<html><body><h1>Console PS5 Slim Digital</h1><p>Por R$ ${price} no pix</p></body></html>`;
const discoveryJson = (items: Array<{ url: string; value: number; label: string }>) =>
  JSON.stringify({ findings: items.map((i) => ({ found: true, value: i.value, currency: 'BRL', title: i.label, source_url: i.url, evidence: 'e', confidence: 0.9, price_regex: REGEX })) });

function setup() {
  const db = openDb(':memory:');
  const t = db.createTracker(priceTracker);
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
  const searchScript: Array<string | Error> = [];
  let searchCalls = 0;
  const llm: LlmClient = {
    async search(req) {
      searchCalls++;
      const next = searchScript.shift();
      if (next === undefined) throw new Error('sem resposta de busca no script');
      if (next instanceof Error) throw next;
      return { text: next, usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } };
    },
    async chat() { throw new Error('IA do plano B não prevista neste teste'); },
  };
  const notifier = new Notifier(db, transport, now);
  return { db, t, sent, pages, searchScript, advance, deps: { db, llm, notifier, models, now, fetchPage }, searches: () => searchCalls };
}

describe('#1 busca que falhou também esfria (sem repetir a busca cara a cada verificação)', () => {
  it('acompanhamento de preço sem fontes: se a busca falha, só tenta de novo depois de 1 h', async () => {
    const s = setup();
    s.searchScript.push(new Error('API fora do ar'));
    const first = await runCheck(s.deps, s.t.id);
    expect(first.ok).toBe(false);
    expect(s.searches()).toBe(1);
    for (let i = 0; i < 3; i++) {
      s.advance(15);
      const r = await runCheck(s.deps, s.t.id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/falhou há pouco/i);
    }
    expect(s.searches()).toBe(1); // nenhuma busca extra em 45 min
    s.advance(20); // passou 1 h desde a falha
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    s.pages['https://l/a'] = page('3524,00');
    expect((await runCheck(s.deps, s.t.id)).ok).toBe(true);
    expect(s.searches()).toBe(2);
  });

  it('descoberta diária que falhou não impede a rotina por código de seguir funcionando', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.advance(25 * 60);
    s.searchScript.push(new Error('API fora do ar'));
    expect((await runCheck(s.deps, s.t.id)).ok).toBe(false); // descoberta devida falhou
    s.advance(15);
    s.pages['https://l/a'] = page('3400,00');
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, alerted: true });
    expect(s.searches()).toBe(2); // sem nova busca: a rotina leu a página
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('routine');
  });

  it('busca de reserva que falhou também não repete antes de 1 h', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.pages['https://l/a'] = { ok: false, kind: 'blocked', status: 429, message: 'O site bloqueou o acesso automático (HTTP 429).' };
    s.advance(7 * 60);
    s.searchScript.push(new Error('API fora do ar'));
    await runCheck(s.deps, s.t.id); // reserva tentada e falhou
    expect(s.searches()).toBe(2);
    for (let i = 0; i < 3; i++) { s.advance(15); await runCheck(s.deps, s.t.id); }
    expect(s.searches()).toBe(2);
  });
});
