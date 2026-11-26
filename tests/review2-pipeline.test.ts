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
const blocked: FetchResult = { ok: false, kind: 'blocked', status: 429, message: 'O site bloqueou o acesso automático (HTTP 429).' };
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
  const searchScript: string[] = [];
  let searchCalls = 0;
  let chatText = '{"value": null}';
  const llm: LlmClient = {
    async search(req) {
      searchCalls++;
      const text = searchScript.shift();
      if (text === undefined) throw new Error('sem resposta de busca no script');
      return { text, usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } };
    },
    async chat(req) { return { text: chatText, toolUses: [], content: [], usage: { model: req.model, inputTokens: 300, outputTokens: 10, searches: 0 } }; },
  };
  const notifier = new Notifier(db, transport, now);
  return { db, t, sent, pages, searchScript, advance, deps: { db, llm, notifier, models, now, fetchPage }, searches: () => searchCalls, setChat: (t: string) => { chatText = t; } };
}

describe('#1 busca de reserva não roda a cada verificação', () => {
  it('se todas as fontes falham logo depois da descoberta, registra a falha SEM busca cara e conta a falha da fonte', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.pages['https://l/a'] = blocked;
    for (let i = 0; i < 3; i++) { s.advance(15); await runCheck(s.deps, s.t.id); }
    expect(s.searches()).toBe(1); // nenhuma busca cara extra
    const checks = s.db.listChecks(s.t.id);
    expect(checks[0]).toMatchObject({ ok: false, mode: 'routine' });
    expect(checks[0].error).toMatch(/nenhuma fonte/i);
    expect(s.db.listSources(s.t.id)[0]).toMatchObject({ status: 'failing', consecutiveFailures: 3 });
    // e o aviso de 2 falhas seguidas sai normalmente (a contagem não é zerada por uma busca)
    expect(s.sent.filter((m) => m.includes('não consegui ler')).length).toBe(1);
  });

  it('passadas 6 h sem preço, a busca de reserva roda uma vez e depois volta a esperar', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.pages['https://l/a'] = blocked;
    s.advance(6 * 60 + 5);
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3500, label: 'Loja A' }]));
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    expect(s.searches()).toBe(2);
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('fallback');
    s.advance(15);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(2); // de novo só depois de outras 6 h
  });
});

describe('#2 plausibilidade por fonte, não pelo menor valor do acompanhamento', () => {
  it('uma loja legitimamente 45% mais barata que o valor geral é lida (e alerta), em vez de virar falha', async () => {
    const s = setup();
    const a = s.db.upsertSource(s.t.id, { url: 'https://l/a', label: 'Loja A', status: 'ok', rule: { type: 'regex', pattern: REGEX }, lastValue: 2000 });
    const b = s.db.upsertSource(s.t.id, { url: 'https://l/b', label: 'Loja B', status: 'ok', rule: { type: 'regex', pattern: REGEX }, lastValue: 1100 });
    s.db.addCheck({ trackerId: s.t.id, at: '2026-01-10T09:30:00Z', ok: true, mode: 'discovery', model: 'm', costUsd: 0, findings: [
      { found: true, value: 2000, currency: 'BRL', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9 }] });
    s.pages['https://l/a'] = page('2000,00');
    s.pages['https://l/b'] = page('1050,00'); // -47% do valor geral (2000), mas -4,5% da própria loja
    s.advance(15);
    const r = await runCheck(s.deps, s.t.id);
    expect(r).toMatchObject({ ok: true, alerted: true });
    const check = s.db.listChecks(s.t.id)[0];
    expect(check.sources.find((x) => x.url === 'https://l/b')).toMatchObject({ ok: true, value: 1050 });
    expect(s.db.getSource(b.id)!.consecutiveFailures).toBe(0);
    expect(a.id).not.toBe(b.id);
  });

  it('um valor absurdo da MESMA loja (acima de 40% do que ela mostrava) continua sendo recusado', async () => {
    const s = setup();
    s.db.upsertSource(s.t.id, { url: 'https://l/a', label: 'Loja A', status: 'ok', rule: { type: 'regex', pattern: REGEX }, lastValue: 2000 });
    s.db.addCheck({ trackerId: s.t.id, at: '2026-01-10T09:30:00Z', ok: true, mode: 'discovery', model: 'm', costUsd: 0, findings: [
      { found: true, value: 2000, currency: 'BRL', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9 }] });
    s.pages['https://l/a'] = page('45,00'); // capinha ou lixo
    s.setChat('{"value": 45}');
    s.advance(15);
    await runCheck(s.deps, s.t.id);
    expect(s.db.listChecks(s.t.id)[0].sources[0]).toMatchObject({ ok: false, error: expect.stringContaining('fora do esperado') });
  });
});

describe('#9 histórico da descoberta não mostra fonte falhando como lida', () => {
  it('fonte em falha aparece como falha (com o motivo) no resumo da busca completa', async () => {
    const s = setup();
    s.pages['https://l/a'] = page('3524,00');
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    s.pages['https://l/a'] = blocked;
    s.advance(15); await runCheck(s.deps, s.t.id);
    s.advance(15); await runCheck(s.deps, s.t.id);
    // descoberta devida (25 h depois); o site continua bloqueado
    s.advance(25 * 60);
    s.searchScript.push(discoveryJson([{ url: 'https://l/a', value: 3524, label: 'Loja A' }]));
    await runCheck(s.deps, s.t.id);
    const check = s.db.listChecks(s.t.id)[0];
    expect(check.mode).toBe('discovery');
    expect(check.sources[0]).toMatchObject({ ok: false, error: expect.stringContaining('bloqueou') });
  });
});
