import type { Finding, PriceRule, ReadMethod, SourceResult, Tracker } from '../shared/types';
import type { Usage } from './cost';
import type { Db } from './db';
import { isReliablePrice, parsePrice } from './decide';
import type { FetchResult } from './fetcher';
import { extractGenericPrice, htmlToText, snippetsAround } from './html';
import type { LlmClient } from './llm';

export const MAX_SOURCES_PER_TRACKER = 4;
/** Variação máxima aceita em relação ao último valor confiável; acima disso a leitura é tratada como suspeita. */
export const MAX_VARIATION = 0.4;
const MAX_PATTERN_LENGTH = 400;
const LEARN_TOLERANCE = 0.005;

export function plausible(value: number, lastValue: number | undefined): boolean {
  if (!(value > 0)) return false;
  if (lastValue === undefined || !(lastValue > 0)) return true;
  return Math.abs(value - lastValue) / lastValue <= MAX_VARIATION;
}

/** Aplica uma regra a uma página (HTML). Nunca lança: regra inválida ou sem resultado devolve undefined. */
export function applyRule(rule: PriceRule, html: string): number | undefined {
  if (rule.type === 'generic') return extractGenericPrice(html);
  if (!rule.pattern || rule.pattern.length > MAX_PATTERN_LENGTH) return undefined;
  try {
    const m = new RegExp(rule.pattern, 'i').exec(htmlToText(html));
    return m && m[1] !== undefined ? parsePrice(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

export interface ReaderDeps {
  fetchPage(url: string): Promise<FetchResult>;
  tracker: Tracker;
  /** Último valor confiável do acompanhamento, para validar a leitura. */
  lastValue?: number;
  llm?: LlmClient;
  model: string;
}

export interface SourceInfo {
  id?: number;
  url: string;
  label?: string;
  rule?: PriceRule;
}

const AI_SYSTEM =
  'Você extrai o preço atual de um produto a partir de trechos de uma página de loja brasileira. ' +
  'Responda SOMENTE com JSON no formato {"value": <número em reais, sem símbolo> ou null}. ' +
  'Se houver vários preços, escolha o do produto procurado (prefira o preço à vista/Pix do produto, não de acessórios nem parcelas). ' +
  'Se o preço do produto não estiver nos trechos, responda {"value": null}.';

function parseAiValue(text: string): number | null | undefined {
  const candidates = [text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const j = JSON.parse(c.trim());
      if (j && 'value' in j) return j.value === null ? null : parsePrice(j.value) ?? null;
    } catch { /* tenta o próximo */ }
  }
  return undefined;
}

function keywordsOf(t: Tracker): string[] {
  return [...t.include, ...t.name.split(/\s+/)].map((k) => k.trim()).filter((k) => k.length > 2);
}

/** Lê o preço de uma fonte: plano A (regra/dados estruturados, sem IA) e, se falhar, plano B (IA lê só um trecho). */
export async function readSource(deps: ReaderDeps, source: SourceInfo): Promise<{ result: SourceResult; usages: Usage[] }> {
  const usages: Usage[] = [];
  const meta = { sourceId: source.id, url: source.url, label: source.label };
  const fail = (error: string) => ({ result: { ...meta, ok: false, error } as SourceResult, usages });
  const done = (method: ReadMethod, value: number) => ({ result: { ...meta, ok: true, method, value } as SourceResult, usages });

  const page = await deps.fetchPage(source.url);
  if (!page.ok) return fail(page.message);
  const html = page.html;

  // Plano A: regra aprendida e, depois, dados estruturados.
  if (source.rule) {
    const v = applyRule(source.rule, html);
    if (v !== undefined && plausible(v, deps.lastValue)) return done(source.rule.type === 'generic' ? 'generic' : 'rule', v);
  }
  if (source.rule?.type !== 'generic') {
    const g = extractGenericPrice(html);
    if (g !== undefined && plausible(g, deps.lastValue)) return done('generic', g);
  }

  // Plano B: a IA lê só alguns trechos do texto da página.
  const text = htmlToText(html);
  const snippets = snippetsAround(text, { keywords: keywordsOf(deps.tracker), max: 3, radius: 300 });
  if (snippets.length === 0) return fail('O preço não aparece no HTML da página (provavelmente montado por JavaScript).');
  if (!deps.llm) return fail('A regra de leitura não funcionou e a IA não está disponível.');

  const t = deps.tracker;
  const prompt = [
    `Produto procurado: ${t.goal}`,
    t.include.length ? `Considerar: ${t.include.join('; ')}` : '',
    t.exclude.length ? `Ignorar: ${t.exclude.join('; ')}` : '',
    'Trechos da página:',
    ...snippets.map((s, i) => `--- trecho ${i + 1} ---\n${s}`),
  ].filter(Boolean).join('\n');
  let reply;
  try {
    reply = await deps.llm.chat({ model: deps.model, system: AI_SYSTEM, messages: [{ role: 'user', content: prompt }] });
  } catch (e) {
    return fail(`Falha ao consultar a IA: ${(e as Error).message}`);
  }
  usages.push(reply.usage);
  const value = parseAiValue(reply.text);
  if (value === undefined || value === null) return fail('A IA não encontrou o preço do produto nos trechos da página.');
  if (!plausible(value, deps.lastValue)) return fail(`A IA leu R$ ${value.toFixed(2).replace('.', ',')}, valor fora do esperado em relação ao último preço.`);
  return done('ai', value);
}

function valueInText(text: string, value: number): boolean {
  const fixed = value.toFixed(2);
  const [int, dec] = fixed.split('.');
  const plain = `${int},${dec}`;
  const thousands = `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
  return text.includes(plain) || text.includes(thousands);
}

export interface LearnDeps {
  db: Db;
  fetchPage(url: string): Promise<FetchResult>;
}

/**
 * Depois da busca completa: baixa cada página citada e só guarda a fonte se o código (regra da IA ou dados
 * estruturados) reproduz o preço visto pela IA, ou se o preço ao menos está no texto (o plano B consegue ler).
 * Páginas onde nada disso ocorre ficam como "unreadable" com o motivo, para o relatório explicar.
 */
export async function learnSources(deps: LearnDeps, tracker: Tracker, findings: Finding[]): Promise<void> {
  const seen = new Set<string>();
  const candidates = findings
    .filter((f) => isReliablePrice(f) && f.sourceUrl && /^https?:\/\//i.test(f.sourceUrl))
    .filter((f) => (seen.has(f.sourceUrl!) ? false : (seen.add(f.sourceUrl!), true)))
    .slice(0, MAX_SOURCES_PER_TRACKER);

  for (const f of candidates) {
    const url = f.sourceUrl!;
    const value = f.value as number;
    const label = f.title;
    const page = await deps.fetchPage(url);
    if (!page.ok) {
      deps.db.upsertSource(tracker.id, { url, label, status: 'unreadable', lastError: page.message });
      continue;
    }
    const close = (v: number | undefined) => v !== undefined && Math.abs(v - value) / value <= LEARN_TOLERANCE;

    if (f.priceRegex) {
      const rule: PriceRule = { type: 'regex', pattern: f.priceRegex };
      if (close(applyRule(rule, page.html))) { deps.db.upsertSource(tracker.id, { url, label, rule, status: 'ok', lastValue: value }); continue; }
    }
    if (close(extractGenericPrice(page.html))) {
      deps.db.upsertSource(tracker.id, { url, label, rule: { type: 'generic' }, status: 'ok', lastValue: value });
      continue;
    }
    if (valueInText(htmlToText(page.html), value)) {
      deps.db.upsertSource(tracker.id, { url, label, status: 'ok', lastValue: value });
      continue;
    }
    deps.db.upsertSource(tracker.id, {
      url, label, status: 'unreadable',
      lastError: 'O preço não aparece no HTML da página (provavelmente montado por JavaScript): só a busca completa consegue ver esse site.',
    });
  }
}
