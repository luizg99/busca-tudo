import type { PriceRule } from '../shared/types';
import type { Usage } from './cost';
import { htmlToText } from './html';
import type { LlmClient } from './llm';
import { applyRule, isRiskyPattern } from './sources';

/**
 * Ensina o código a ler o preço de uma página, uma vez (na busca diária), para que as leituras de 15 em 15 min não
 * precisem de IA. Primeiro o próprio código monta a regra a partir de onde o preço aparece no texto; só se não der,
 * a IA propõe uma regra. Em ambos os casos a regra só é aceita se o código, aplicando-a, lê exatamente o preço.
 */

const LEARN_TOLERANCE = 0.005;
const close = (v: number | undefined, value: number) => v !== undefined && Math.abs(v - value) / value <= LEARN_TOLERANCE;

/** Formas de escrever o preço no texto (com ou sem separador de milhar; com centavos ou inteiro). */
function valuePatterns(value: number): RegExp[] {
  const fixed = value.toFixed(2);
  const [int, dec] = fixed.split('.');
  const thousands = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [`${thousands},${dec}`, `${int},${dec}`];
  if (Number.isInteger(value)) forms.push(thousands, int);
  return forms.map((n) => new RegExp(`(?<![\\d.,])${esc(n)}(?![\\d]|,[1-9])`, 'g'));
}

/** Onde o preço aparece pela primeira vez no texto. */
function findValue(text: string, value: number): { index: number; length: number } | undefined {
  for (const re of valuePatterns(value)) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return { index: m.index, length: m[0].length };
  }
  return undefined;
}

/**
 * O preço aparece JUNTO do nome do produto (a até `radius` caracteres de uma palavra-chave). Um número solto em outro
 * lugar da página (item de "compre junto", preço "de", total parcelado) não conta.
 */
export function pageShowsValueNear(html: string, value: number, keywords: string[], radius = 150): boolean {
  const text = htmlToText(html);
  const lower = text.toLowerCase();
  const kws = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 2);
  if (kws.length === 0) return false;
  for (const re of valuePatterns(value)) {
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      const around = lower.slice(Math.max(0, i - radius), i + m[0].length + radius);
      if (kws.some((k) => around.includes(k))) return true;
    }
  }
  return false;
}

const NUMBER = /[\d][\d.,]*/g;

/** Texto antes do preço vira âncora: palavras literais; números (que mudam, ex.: preço "de") viram curinga limitado. */
function anchorPattern(raw: string): string {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(NUMBER)) {
    out += literal(raw.slice(last, m.index));
    out += '[\\d.,]{1,12}';
    last = (m.index ?? 0) + m[0].length;
  }
  return out + literal(raw.slice(last));
}

function literal(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s{0,3}');
}

/** Regra montada só pelo código, conferida na própria página; undefined se não houver uma confiável. */
export function induceRule(html: string, value: number): PriceRule | undefined {
  const text = htmlToText(html);
  const at = findValue(text, value);
  if (!at) return undefined;
  for (const size of [24, 40, 64]) {
    let start = Math.max(0, at.index - size);
    // não começa no meio de uma palavra
    if (start > 0) {
      const space = text.slice(start, at.index).search(/\s/);
      if (space < 0) continue;
      start += space + 1;
    }
    const before = text.slice(start, at.index);
    if (!/[a-zà-ú$]/i.test(before)) continue; // âncora precisa ter alguma palavra
    const pattern = `${anchorPattern(before)}([\\d.]{1,12}(?:,\\d{2})?)`;
    if (pattern.length > 400 || isRiskyPattern(pattern)) continue;
    const rule: PriceRule = { type: 'regex', pattern };
    if (close(applyRule(rule, html), value)) return rule;
  }
  return undefined;
}

const TEACH_SYSTEM =
  'Você cria expressões regulares para ler o preço de um produto no TEXTO de uma página de loja brasileira. ' +
  'Responda SOMENTE com JSON {"regex": "..."}: sintaxe JavaScript, sem barras, case-insensitive, com UM grupo de captura ' +
  'que captura o preço exatamente como escrito. Ancore em palavras fixas próximas ao preço (nunca em outros números, que mudam) ' +
  'e use só quantificadores limitados, como {0,40}. Se não houver como, responda {"regex": null}.';

/** A IA propõe a regra (uma chamada pequena); só é aceita se o código ler exatamente o preço com ela. */
export async function teachRule(llm: LlmClient, model: string, html: string, value: number): Promise<{ rule?: PriceRule; usages: Usage[] }> {
  const text = htmlToText(html);
  const at = findValue(text, value);
  if (!at) return { usages: [] }; // o preço nem está no texto: a IA não teria como ensinar
  const snippet = text.slice(Math.max(0, at.index - 300), at.index + at.length + 150);
  let reply;
  try {
    reply = await llm.chat({
      model,
      system: TEACH_SYSTEM,
      messages: [{ role: 'user', content: `Preço a capturar: ${text.slice(at.index, at.index + at.length)}\nTrecho da página:\n${snippet}` }],
    });
  } catch {
    return { usages: [] };
  }
  const usages = [reply.usage];
  let pattern: unknown;
  try {
    const raw = reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1);
    pattern = JSON.parse(raw).regex;
  } catch {
    return { usages };
  }
  if (typeof pattern !== 'string' || !pattern || pattern.length > 400 || isRiskyPattern(pattern)) return { usages };
  const rule: PriceRule = { type: 'regex', pattern };
  return close(applyRule(rule, html), value) ? { rule, usages } : { usages };
}
