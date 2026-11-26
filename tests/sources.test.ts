import { describe, it, expect, vi } from 'vitest';
import { applyRule, plausible, readSource, learnSources } from '../src/service/sources';
import { openDb } from '../src/service/db';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, Tracker } from '../src/shared/types';

const usage = { model: 'claude-haiku-5-5', inputTokens: 400, outputTokens: 20, searches: 0 };
const tracker: Tracker = {
  id: 1, name: 'PS5 Slim Digital', kind: 'price', goal: 'Preço do PS5 Slim digital novo', include: ['PS5 Slim Digital'], exclude: ['usado'],
  intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '2026-01-01T00:00:00Z',
};

const PAGE_TEXT = '<html><body><h1>Console PlayStation 5 Slim Digital</h1><p>Por R$ 3524,00 no pix</p><p>Capinha R$ 45,10</p></body></html>';
const PAGE_LD = '<html><script type="application/ld+json">{"@type":"Product","offers":{"price":"3524.00"}}</script><body>sem texto de preço</body></html>';
const PAGE_JS = '<html><body><div id="app"></div><script>window.__DATA__={"preco":3524}</script></body></html>';

const fetcher = (pages: Record<string, FetchResult | string>) => async (url: string): Promise<FetchResult> => {
  const p = pages[url];
  if (p === undefined) return { ok: false, kind: 'http', status: 404, message: 'O site respondeu com erro HTTP 404.' };
  return typeof p === 'string' ? { ok: true, html: p } : p;
};
const llmReturning = (json: string) => {
  const chat = vi.fn(async () => ({ text: json, toolUses: [], content: [], usage }));
  const llm: LlmClient = { async search() { throw new Error('x'); }, chat };
  return { llm, chat };
};
const base = (over: Record<string, unknown> = {}) => ({ tracker, model: 'claude-haiku-5-5', lastValue: 3500, ...over });

describe('applyRule', () => {
  it('regex: captura o preço no texto visível', () => {
    expect(applyRule({ type: 'regex', pattern: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' }, PAGE_TEXT)).toBe(3524);
  });
  it('regex inválida, sem captura ou preço absurdo devolve undefined sem lançar', () => {
    expect(applyRule({ type: 'regex', pattern: '([' }, PAGE_TEXT)).toBeUndefined();
    expect(applyRule({ type: 'regex', pattern: 'nada disso' }, PAGE_TEXT)).toBeUndefined();
    expect(applyRule({ type: 'regex', pattern: 'Capinha R\\$\\s*(abc)' }, PAGE_TEXT)).toBeUndefined();
  });
  it('generic: lê dado estruturado', () => {
    expect(applyRule({ type: 'generic' }, PAGE_LD)).toBe(3524);
  });
});

describe('plausible', () => {
  it('aceita até 40% de variação sobre o último valor; sem último valor aceita qualquer positivo', () => {
    expect(plausible(3600, 3500)).toBe(true);
    expect(plausible(2200, 3500)).toBe(true); // -37%
    expect(plausible(4800, 3500)).toBe(true); // +37%
    expect(plausible(1800, 3500)).toBe(false); // -49%
    expect(plausible(5000, 3500)).toBe(false); // +43%
    expect(plausible(100, undefined)).toBe(true);
    expect(plausible(0, 3500)).toBe(false);
    expect(plausible(-5, undefined)).toBe(false);
  });
});

describe('readSource', () => {
  it('plano A: regra aprendida lê o preço sem chamar a IA', async () => {
    const { llm, chat } = llmReturning('{"value": 1}');
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_TEXT }), llm },
      { url: 'https://l/a', label: 'Loja A', rule: { type: 'regex', pattern: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' } });
    expect(r.result).toMatchObject({ ok: true, method: 'rule', value: 3524, url: 'https://l/a' });
    expect(r.usages).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('plano A: se a regra quebrou, usa os dados estruturados da página', async () => {
    const { llm, chat } = llmReturning('{"value": 1}');
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_LD }), llm },
      { url: 'https://l/a', rule: { type: 'regex', pattern: 'sumiu\\s*([\\d,]+)' } });
    expect(r.result).toMatchObject({ ok: true, method: 'generic', value: 3524 });
    expect(chat).not.toHaveBeenCalled();
  });

  it('plano B: a IA lê só o trecho da página e o uso é devolvido para o custo', async () => {
    const { llm, chat } = llmReturning('```json\n{"value": 3524}\n```');
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_TEXT }), llm }, { url: 'https://l/a' });
    expect(r.result).toMatchObject({ ok: true, method: 'ai', value: 3524 });
    expect(r.usages).toEqual([usage]);
    const prompt = JSON.stringify(chat.mock.calls[0][0].messages);
    expect(prompt).toContain('PS5 Slim Digital');
    expect(prompt).toContain('R$ 3524,00');
    expect(prompt).not.toContain('<h1>'); // só texto, nunca o HTML inteiro
  });

  it('plano B: a IA não achou (null) ou devolveu valor absurdo = falha explicada', async () => {
    const nulo = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_TEXT }), llm: llmReturning('{"value": null}').llm }, { url: 'https://l/a' });
    expect(nulo.result).toMatchObject({ ok: false });
    expect(nulo.result.error).toMatch(/IA/);
    const absurdo = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_TEXT }), llm: llmReturning('{"value": 10}').llm }, { url: 'https://l/a' });
    expect(absurdo.result.ok).toBe(false);
    expect(absurdo.result.error).toMatch(/fora do esperado/);
  });

  it('página bloqueada: falha com o motivo do site e sem chamar a IA', async () => {
    const { llm, chat } = llmReturning('{"value": 1}');
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': { ok: false, kind: 'blocked', status: 429, message: 'O site bloqueou o acesso automático (HTTP 429).' } }), llm }, { url: 'https://l/a' });
    expect(r.result).toMatchObject({ ok: false, error: 'O site bloqueou o acesso automático (HTTP 429).' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('página sem nenhum preço no texto (montada por JavaScript): falha e não gasta IA', async () => {
    const { llm, chat } = llmReturning('{"value": 3524}');
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/js': PAGE_JS }), llm }, { url: 'https://l/js' });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toMatch(/JavaScript/);
    expect(chat).not.toHaveBeenCalled();
  });

  it('sem IA disponível e sem regra que funcione: falha', async () => {
    const r = await readSource({ ...base(), fetchPage: fetcher({ 'https://l/a': PAGE_TEXT }) }, { url: 'https://l/a' });
    expect(r.result.ok).toBe(false);
  });
});

describe('learnSources', () => {
  const f = (over: Partial<Finding> = {}): Finding => ({ found: true, value: 3524, currency: 'BRL', title: 'Loja A', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9, ...over });
  function setup(pages: Record<string, FetchResult | string>) {
    const db = openDb(':memory:');
    const t = db.createTracker({ ...tracker, digest: 'none' });
    return { db, t, deps: (extra = {}) => ({ db, fetchPage: fetcher(pages), ...extra }) };
  }

  it('guarda a regra da IA quando ela reproduz o preço que a IA viu', async () => {
    const { db, t, deps } = setup({ 'https://l/a': PAGE_TEXT });
    await learnSources(deps(), t, [f({ priceRegex: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' })]);
    const s = db.listSources(t.id)[0];
    expect(s).toMatchObject({ url: 'https://l/a', label: 'Loja A', status: 'ok', rule: { type: 'regex' }, lastValue: 3524 });
  });

  it('regra errada da IA é descartada; se houver dado estruturado, usa o genérico', async () => {
    const { db, t, deps } = setup({ 'https://l/a': PAGE_LD });
    await learnSources(deps(), t, [f({ priceRegex: 'errada\\s*([\\d,]+)' })]);
    expect(db.listSources(t.id)[0]).toMatchObject({ status: 'ok', rule: { type: 'generic' } });
  });

  it('preço presente no texto mas sem regra válida: guarda sem regra (o plano B lê com IA barata)', async () => {
    const { db, t, deps } = setup({ 'https://l/a': PAGE_TEXT });
    await learnSources(deps(), t, [f()]);
    const s = db.listSources(t.id)[0];
    expect(s.status).toBe('ok');
    expect(s.rule).toBeUndefined();
  });

  it('preço que não está no HTML (JavaScript) vira "unreadable" com o motivo', async () => {
    const { db, t, deps } = setup({ 'https://l/a': PAGE_JS });
    await learnSources(deps(), t, [f()]);
    expect(db.listSources(t.id)[0]).toMatchObject({ status: 'unreadable', lastError: expect.stringContaining('JavaScript') });
  });

  it('página bloqueada na hora de aprender vira "unreadable" com o motivo do site', async () => {
    const { db, t, deps } = setup({ 'https://l/a': { ok: false, kind: 'blocked', status: 429, message: 'O site bloqueou o acesso automático (HTTP 429).' } });
    await learnSources(deps(), t, [f()]);
    expect(db.listSources(t.id)[0]).toMatchObject({ status: 'unreadable', lastError: expect.stringContaining('bloqueou') });
  });

  it('ignora achados de baixa confiança, sem URL ou em outra moeda; limita a 4 fontes', async () => {
    const pages: Record<string, string> = {};
    const findings: Finding[] = [];
    for (let i = 0; i < 6; i++) { pages[`https://l/${i}`] = PAGE_TEXT; findings.push(f({ sourceUrl: `https://l/${i}`, title: `L${i}` })); }
    findings.push(f({ sourceUrl: 'https://l/baixa', confidence: 0.3 }), f({ sourceUrl: undefined }), f({ sourceUrl: 'https://l/usd', currency: 'USD' }));
    const { db, t, deps } = setup(pages);
    await learnSources(deps(), t, findings);
    expect(db.listSources(t.id)).toHaveLength(4);
  });
});
