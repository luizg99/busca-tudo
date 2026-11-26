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
/** Padrões que já estouraram o limite de tempo (em memória; recomeça a cada partida do serviço). */
const slowPatterns = new Set<string>();
const MAX_SLOW_PATTERNS = 500;
/** Um único ambiente isolado reaproveitado em todas as chamadas (criar um por chamada é lento). */
const sandbox = vm.createContext({ re: undefined as unknown, text: '' });

/** Repetição de um GRUPO com limite maior que isso conta como "ampla": um grupo repetido 50 vezes explode igual a um sem limite. */
const SMALL_REPEAT_MAX = 3;

/**
 * Quantificador que começa em `i`.
 * - `wide`: pode repetir muitas vezes (*, +, {n,} ou máximo > 3). É o que importa quando o GRUPO inteiro se repete.
 * - `variable`: a largura do que ele casa varia (*, +, {n,} ou {n,m} com m > n e m > 3). É o que importa DENTRO do
 *   grupo: largura fixa ({4}) é segura; {1,50} não é.
 */
function quantifierAt(p: string, i: number): { wide: boolean; variable: boolean; unbounded: boolean; length: number } {
  const c = p[i];
  if (c === '*' || c === '+') return { wide: true, variable: true, unbounded: true, length: p[i + 1] === '?' ? 2 : 1 };
  if (c === '?') return { wide: false, variable: false, unbounded: false, length: p[i + 1] === '?' ? 2 : 1 };
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 16));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      return { wide: max > SMALL_REPEAT_MAX, variable: max > min && max > SMALL_REPEAT_MAX, unbounded: max === Infinity, length: m[0].length + (p[i + m[0].length] === '?' ? 1 : 0) };
    }
  }
  return { wide: false, variable: false, unbounded: false, length: 0 };
}

/** Mais quantificadores sem limite que isso num mesmo padrão = custo polinomial alto ((.*)(.*)(.*)...x). */
const MAX_UNBOUNDED_QUANTIFIERS = 5;

/**
 * Detecta padrões com risco de backtracking catastrófico (ReDoS): grupo que contém repetição de largura variável (em
 * qualquer profundidade) ou alternância e que é, ele mesmo, repetido muitas vezes. Largura fixa, como (\d{4}-\d{2})+, e
 * repetição pequena, como {1,3}, são aceitas.
 */
export function isRiskyPattern(pattern: string): boolean {
  type Group = { variable: boolean; alt: boolean };
  const stack: Group[] = [];
  let unboundedCount = 0;
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
      stack.push({ variable: false, alt: false });
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
      if (q.unbounded && ++unboundedCount > MAX_UNBOUNDED_QUANTIFIERS) return true;
      if (g) {
        if (q.wide && (g.variable || g.alt)) return true; // largura variável (ou alternância) dentro de grupo repetido muitas vezes
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.variable = parent.variable || g.variable || q.variable;
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
      if (q.unbounded && ++unboundedCount > MAX_UNBOUNDED_QUANTIFIERS) return true;
      if (q.variable && stack.length) stack[stack.length - 1].variable = true;
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
  if (slowPatterns.has(rule.pattern) || isRiskyPattern(rule.pattern)) return undefined;
  try {
    sandbox.re = new RegExp(rule.pattern, 'i');
    sandbox.text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    const m = vm.runInContext('re.exec(text)', sandbox, { timeout: REGEX_TIMEOUT_MS }) as RegExpExecArray | null;
    return m && m[1] !== undefined ? parsePrice(m[1]) : undefined;
  } catch (e) {
    // um padrão que estourou o tempo é lembrado: não gasta mais esse tempo em cada verificação
    if ((e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      if (slowPatterns.size >= MAX_SLOW_PATTERNS) slowPatterns.clear();
      slowPatterns.add(rule.pattern);
    }
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

  const suspect = (value: number) => ({
    result: { ...meta, ok: false, suspectValue: value, error: `Leu R$ ${value.toFixed(2).replace('.', ',')}, valor fora do esperado em relação ao último preço (pede confirmação pela busca completa).` } as SourceResult,
    usages,
  });

  // Plano A: regra aprendida e, como reserva, os dados estruturados SÓ se o aprendizado confirmou que reproduzem o preço
  // (senão a página pode publicar um preço de tabela diferente do preço de venda que acompanhamos).
  if (source.rule) {
    const v = applyRule(source.rule, html);
    if (v !== undefined) {
      if (plausible(v, deps.lastValue)) return done(source.rule.type === 'generic' ? 'generic' : 'rule', v);
      return suspect(v); // lido, mas fora do esperado: confirmar, não gastar IA
    }
    if (source.rule.type === 'regex' && source.rule.genericOk) {
      const g = extractGenericPrice(html);
      if (g !== undefined) return plausible(g, deps.lastValue) ? done('generic', g) : suspect(g);
    }
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
  if (!plausible(value, deps.lastValue)) return suspect(value);
  return done('ai', value);
}

function valueInText(text: string, value: number): boolean {
  const fixed = value.toFixed(2);
  const [int, dec] = fixed.split('.');
  const thousandsInt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // fronteiras: 299,00 não vale dentro de 1.299,00 nem de 2299,00
  const withCents = [`${int},${dec}`, `${thousandsInt},${dec}`].map((n) => `(?<![\\d.,])${escape(n)}(?!\\d)`);
  // preço inteiro sem centavos ("R$ 3.499"): aceita também seguido de ",00", mas não de outros centavos
  const whole = Number.isInteger(value) ? [int, thousandsInt].map((n) => `(?<![\\d.,])${escape(n)}(?!\\d)(?!,[1-9])`) : [];
  return [...withCents, ...whole].some((p) => new RegExp(p).test(text));
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
    // loja, link da loja e cupom ficam com a fonte: a rotina por código os mostra nos alertas seguintes (null apaga o antigo)
    const origin = f.via || f.store || f.coupon || f.storeUrl ? { store: f.store, storeUrl: f.storeUrl, coupon: f.coupon, via: f.via } : null;
    // Uma fonte que já funcionava não é rebaixada por uma falha pontual: quem decide isso é a rotina (falhas seguidas).
    const known = deps.db.listSources(tracker.id).find((s) => s.url === url);
    const alreadyUsable = known !== undefined && known.status !== 'unreadable';
    const page = await deps.fetchPage(url);
    if (!page.ok) {
      // Falha passageira (timeout, rede, bloqueio, erro do servidor) não diz nada sobre a página: a fonte fica como
      // "failing" e a rotina tenta de novo. Só é "unreadable" quando a falha é definitiva (página inexistente/inválida).
      const transient = page.kind === 'timeout' || page.kind === 'network' || page.kind === 'blocked' || (page.kind === 'http' && (page.status ?? 0) >= 500);
      if (!alreadyUsable) deps.db.upsertSource(tracker.id, { url, label, status: transient ? 'failing' : 'unreadable', lastError: page.message, trustedVia: !!f.via, origin });
      continue;
    }
    const close = (v: number | undefined) => v !== undefined && Math.abs(v - value) / value <= LEARN_TOLERANCE;

    if (f.priceRegex) {
      const rule: PriceRule = { type: 'regex', pattern: f.priceRegex };
      if (close(applyRule(rule, page.html))) {
        // se os dados estruturados também reproduzem o preço, servem de reserva quando a regra quebrar
        if (close(extractGenericPrice(page.html))) rule.genericOk = true;
        deps.db.upsertSource(tracker.id, { url, label, rule, status: 'ok', lastValue: value, trustedVia: !!f.via, origin });
        continue;
      }
    }
    if (close(extractGenericPrice(page.html))) {
      deps.db.upsertSource(tracker.id, { url, label, rule: { type: 'generic' }, status: 'ok', lastValue: value, trustedVia: !!f.via, origin });
      continue;
    }
    if (valueInText(htmlToText(page.html), value)) {
      deps.db.upsertSource(tracker.id, { url, label, status: 'ok', lastValue: value, trustedVia: !!f.via, origin });
      continue;
    }
    if (alreadyUsable) continue;
    deps.db.upsertSource(tracker.id, {
      url, label, status: 'unreadable',
      lastError: 'O preço não aparece no HTML da página (provavelmente montado por JavaScript): só a busca completa consegue ver esse site.',
    });
  }
}
