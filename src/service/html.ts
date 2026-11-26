import { parsePrice } from './decide';

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Code point válido (sem substitutos); fora disso mantém o texto original em vez de lançar RangeError. */
function fromCode(code: number, original: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCode(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => fromCode(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Tags que não quebram a linha (span, b, a...). */
const INLINE_TAGS = /<\/?(?:span|b|strong|i|em|a|sup|sub|small|font|u|mark|abbr|s|del|ins|code|label|bdi|cite)(?:\s[^>]*)?>/gi;
/** Marcador temporário no lugar de uma tag inline. */
const MARK = String.fromCharCode(1);
const MARKS = new RegExp(`${MARK}+`, 'g');
/** "R$" + marcador; dígito + marcador antes de ,N ou .N; "1." ou "1," + marcador + dígito: pedaços de um mesmo preço. */
const PRICE_GLUE = [
  new RegExp(`(R\\$)${MARK}+`, 'g'),
  new RegExp(`(\\d)${MARK}+(?=[.,]\\d)`, 'g'),
  new RegExp(`(\\d[.,])${MARK}+(?=\\d)`, 'g'),
];

/**
 * Texto visível aproximado da página: sem script/style/comentários/tags, entidades decodificadas, espaços compactados.
 * Elementos inline vizinhos só se juntam quando são pedaços de um mesmo preço ("R$" | "1.299" | ",00"); no resto viram
 * palavras separadas (assim "R$ 3.524,00" e "12x de 293,67" não se fundem).
 */
export function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
  let text = noBlocks.replace(INLINE_TAGS, MARK).replace(/<[^>]*>/g, ' ');
  for (const re of PRICE_GLUE) text = text.replace(re, '$1');
  text = text.replace(MARKS, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** Percorre o JSON-LD em ordem e junta, por nó com "offers", os preços das ofertas daquele nó. */
function collectOfferPrices(node: unknown, out: number[], depth = 0): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { node.forEach((n) => collectOfferPrices(n, out, depth + 1)); return; }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if ('offers' in o) {
    const offers = Array.isArray(o.offers) ? o.offers : [o.offers];
    for (const offer of offers) {
      if (offer && typeof offer === 'object') {
        const of = offer as Record<string, unknown>;
        for (const key of ['price', 'lowPrice']) {
          const v = parsePrice(of[key]);
          if (v !== undefined) out.push(v);
        }
        collectOfferPrices(of, out, depth + 1);
      }
    }
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'offers') collectOfferPrices(v, out, depth + 1);
}

interface OfferGroup { product: boolean; prices: number[] }

/** Listas (produtos relacionados, "compre junto") não são o produto principal, mesmo quando contêm Products. */
const LIST_TYPES = ['ItemList', 'ListItem', 'BreadcrumbList', 'OfferCatalog'];

function offerGroups(node: unknown, groups: OfferGroup[], depth = 0, inList = false): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { node.forEach((n) => offerGroups(n, groups, depth + 1, inList)); return; }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const type = Array.isArray(o['@type']) ? o['@type'].map(String) : [String(o['@type'] ?? '')];
  const list = inList || type.some((t) => LIST_TYPES.includes(t));
  if ('offers' in o) {
    const prices: number[] = [];
    collectOfferPrices({ offers: o.offers }, prices);
    if (prices.length) groups.push({ product: !list && type.includes('Product'), prices });
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'offers') offerGroups(v, groups, depth + 1, list);
}

/**
 * Preço publicado como dado estruturado. Vale o primeiro nó do tipo Product (o principal; listas de produtos
 * relacionados e acessórios vêm depois ou são de outro tipo) e, dentro dele, o menor preço das ofertas.
 * Sem Product, o primeiro grupo de ofertas; sem JSON-LD, o primeiro meta/itemprop.
 */
export function extractGenericPrice(html: string): number | undefined {
  const groups: OfferGroup[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { offerGroups(JSON.parse(m[1].trim()), groups); } catch { /* bloco inválido */ }
  }
  const chosen = groups.find((g) => g.product) ?? groups[0]; // entre todos os blocos da página, em ordem
  if (chosen) return Math.min(...chosen.prices);
  for (const m of html.matchAll(/<meta[^>]+(?:product:price:amount|og:price:amount)[^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    const v = c ? parsePrice(c[1]) : undefined;
    if (v !== undefined) return v;
  }
  for (const m of html.matchAll(/<[^>]+itemprop=["']price["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    const v = c ? parsePrice(c[1]) : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Janelas de texto ao redor de valores "R$ x,xx", com as mais ligadas às palavras-chave primeiro. */
export function snippetsAround(text: string, opts: { keywords?: string[]; radius?: number; max?: number } = {}): string[] {
  const radius = opts.radius ?? 300;
  const max = opts.max ?? 3;
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2})/g)) {
    const start = Math.max(0, (m.index ?? 0) - radius);
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + radius);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const keywords = (opts.keywords ?? []).map((k) => k.toLowerCase());
  const windows = ranges.map(([s, e], i) => {
    const w = text.slice(s, e).trim();
    const lower = w.toLowerCase();
    return { w, i, score: keywords.filter((k) => lower.includes(k)).length };
  });
  windows.sort((a, b) => b.score - a.score || a.i - b.i);
  return windows.slice(0, max).map((x) => x.w);
}
