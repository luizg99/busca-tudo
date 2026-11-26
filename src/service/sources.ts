import vm from 'node:vm';
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

const MAX_TEXT_CHARS = 300_000;
const REGEX_TIMEOUT_MS = 150;
/** Um único ambiente isolado reaproveitado em todas as chamadas (criar um por chamada é lento). */
const sandbox = vm.createContext({ re: undefined as unknown, text: '' });

/** Repetição de um GRUPO com limite maior que isso conta como "ampla": um grupo repetido 50 vezes explode igual a um sem limite. */
const SMALL_REPEAT_MAX = 3;

/**
 * Quantificador que começa em `i`. `unbounded`: *, + e {n,} (realmente sem limite). `wide`: sem limite ou com limite
 * grande (>3). Dentro de um grupo só importa o `unbounded`; o `wide` conta quando é o grupo que se repete.
 */
function quantifierAt(p: string, i: number): { unbounded: boolean; wide: boolean; length: number } {
  const c = p[i];
  if (c === '*' || c === '+') return { unbounded: true, wide: true, length: p[i + 1] === '?' ? 2 : 1 };
  if (c === '?') return { unbounded: false, wide: false, length: p[i + 1] === '?' ? 2 : 1 };
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 16));
    if (m) {
      const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
      return { unbounded: max === Infinity, wide: max > SMALL_REPEAT_MAX, length: m[0].length + (p[i + m[0].length] === '?' ? 1 : 0) };
    }
  }
  return { unbounded: false, wide: false, length: 0 };
}

/**
 * Detecta padrões com risco de backtracking catastrófico (ReDoS): grupo que contém repetição sem limite (em qualquer
 * profundidade) ou alternância e que é, ele mesmo, repetido sem limite. Repetição limitada, como {1,3}, é aceita.
 */
export function isRiskyPattern(pattern: string): boolean {
  type Group = { unbounded: boolean; alt: boolean };
  const stack: Group[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') {
      stack.push({ unbounded: false, alt: false });
      i++;
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          while (i < pattern.length && pattern[i] !== '>') i++;
          i++;
        } else if (pattern[i] === '<') i += 2;
        else i++;
      }
      continue;
    }
    if (c === ')') {
      const g = stack.pop();
      i++;
      const q = quantifierAt(pattern, i);
      i += q.length;
      if (g) {
        if (q.wide && (g.unbounded || g.alt)) return true; // grupo com repetição sem limite (ou alternância) repetido muitas vezes
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.unbounded = parent.unbounded || g.unbounded || q.unbounded;
          parent.alt = parent.alt || g.alt;
        }
      }
      continue;
    }
    if (c === '|') {
      if (stack.length) stack[stack.length - 1].alt = true;
      i++;
      continue;
    }
    if (c === '*' || c === '+' || c === '{') {
      const q = quantifierAt(pattern, i);
      if (q.unbounded && stack.length) stack[stack.length - 1].unbounded = true;
      i += q.length || 1;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Aplica uma regra a uma página (HTML). Nunca lança nem trava: regra inválida, perigosa ou sem resultado devolve undefined.
 * A regex vem da IA (a partir de conteúdo da web): é recusada se tiver risco de ReDoS e, de qualquer modo, roda isolada
 * com limite de tempo sobre um texto de tamanho limitado.
 */
export function applyRule(rule: PriceRule, html: string): number | undefined {
  if (rule.type === 'generic') return extractGenericPrice(html);
  if (!rule.pattern || rule.pattern.length > MAX_PATTERN_LENGTH) return undefined;
  if (isRiskyPattern(rule.pattern)) return undefined;
  try {
    sandbox.re = new RegExp(rule.pattern, 'i');
    sandbox.text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    const m = vm.runInContext('re.exec(text)', sandbox, { timeout: REGEX_TIMEOUT_MS }) as RegExpExecArray | null;
    return m && m[1] !== undefined ? parsePrice(m[1]) : undefined;
  } catch {
    return undefined;
  } finally {
    sandbox.re = undefined;
    sandbox.text = '';
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
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // fronteiras: 299,00 não vale dentro de 1.299,00 nem de 2299,00
  return [plain, thousands].some((n) => new RegExp(`(?<![\\d.,])${escape(n)}(?!\\d)`).test(text));
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
    // Uma fonte que já funcionava não é rebaixada por uma falha pontual: quem decide isso é a rotina (falhas seguidas).
    const known = deps.db.listSources(tracker.id).find((s) => s.url === url);
    const alreadyUsable = known !== undefined && known.status !== 'unreadable';
    const page = await deps.fetchPage(url);
    if (!page.ok) {
      if (!alreadyUsable) deps.db.upsertSource(tracker.id, { url, label, status: 'unreadable', lastError: page.message });
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
    if (alreadyUsable) continue;
    deps.db.upsertSource(tracker.id, {
      url, label, status: 'unreadable',
      lastError: 'O preço não aparece no HTML da página (provavelmente montado por JavaScript): só a busca completa consegue ver esse site.',
    });
  }
}
