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
const INLINE_NAMES = new Set(['span', 'b', 'strong', 'i', 'em', 'a', 'sup', 'sub', 'small', 'font', 'u', 'mark', 'abbr', 's', 'del', 'ins', 'code', 'label', 'bdi', 'cite']);
/** Blocos cujo conteúdo não é texto visível. */
const HIDDEN_NAMES = new Set(['script', 'style', 'noscript', 'template']);
/** Marcador temporário no lugar de uma tag inline. */
const MARK = String.fromCharCode(1);
const MAX_HTML_CHARS = 2_000_000;

/**
 * Varredura em tempo linear (sem regex com retrocesso): remove tags, comentários e blocos ocultos. Cada tag inline vira
 * um marcador; as demais viram espaço. Entrada hostil (milhares de "<" ou "<!--" sem fechamento) continua linear.
 */
function stripTags(input: string): string {
  const s = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const lower = s.toLowerCase();
  const lastGt = s.lastIndexOf('>');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) break; // comentário sem fim: descarta o resto
      out.push(' ');
      i = end + 3;
      continue;
    }
    const c = s.charCodeAt(lt + 1);
    const tagStart = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33 || c === 63; // letra, / ! ?
    if (!tagStart) { out.push('<'); i = lt + 1; continue; }
    if (lt > lastGt) { out.push(s.slice(lt)); break; } // não há mais ">": o resto é texto
    const gt = s.indexOf('>', lt + 1);
    const head = lower.slice(lt + 1, Math.min(gt, lt + 24));
    const closing = head.startsWith('/');
    const name = head.slice(closing ? 1 : 0).match(/^[a-z][a-z0-9]*/)?.[0];
    if (name && !closing && HIDDEN_NAMES.has(name)) {
      const close = lower.indexOf('</' + name, gt + 1);
      if (close === -1) break; // bloco sem fechamento: descarta o resto
      const closeGt = s.indexOf('>', close);
      if (closeGt === -1) break;
      out.push(' ');
      i = closeGt + 1;
      continue;
    }
    out.push(name && INLINE_NAMES.has(name) ? MARK : ' ');
    i = gt + 1;
  }
  return out.join('');
}

/** Junta só o que é pedaço de um mesmo preço; o resto vira espaço. */
const PRICE_GLUE: Array<[RegExp, string]> = [
  [new RegExp(`(R\\$)${MARK}+`, 'g'), '$1'], // "R$" | valor
  [new RegExp(`(\\d)${MARK}+(?=[.,])`, 'g'), '$1'], // dígito | separador
  [new RegExp(`([.,])${MARK}+(?=\\d)`, 'g'), '$1'], // separador | dígito
  [new RegExp(`(R\\$\\s*\\d{1,3}(?:\\.\\d{3})*)${MARK}+(\\d{2})(?!\\d)`, 'g'), '$1,$2'], // "R$3.499" | "00" (centavos sem vírgula)
];
const MARKS = new RegExp(`${MARK}+`, 'g');

/**
 * Texto visível aproximado da página: sem script/style/comentários/tags, entidades decodificadas, espaços compactados.
 * Elementos inline vizinhos só se juntam quando são pedaços de um mesmo preço ("R$" | "1.299" | ",00"); no resto viram
 * palavras separadas (assim "R$ 3.524,00" e "12x de 293,67" não se fundem).
 */
export function htmlToText(html: string): string {
  let text = stripTags(html);
  for (const [re, to] of PRICE_GLUE) text = text.replace(re, to);
  text = text.replace(MARKS, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

const UNAVAILABLE = /OutOfStock|SoldOut|Discontinued/i;
const LIST_PRICE_TYPE = /List|Strikethrough|SRP|MSRP|Original/i;
const isBrl = (cur: unknown) => cur === undefined || cur === null || cur === '' || String(cur).toUpperCase() === 'BRL';

/** Preços de venda de uma oferta (JSON-LD): ignora esgotada, outra moeda e preço de tabela/riscado. */
function pricesOfOffer(of: Record<string, unknown>, out: number[], depth: number): void {
  if (UNAVAILABLE.test(String(of.availability ?? ''))) return;
  if (!isBrl(of.priceCurrency)) return;
  for (const key of ['price', 'lowPrice']) {
    const v = parsePrice(of[key]);
    if (v !== undefined) out.push(v);
  }
  const specs = Array.isArray(of.priceSpecification) ? of.priceSpecification : of.priceSpecification ? [of.priceSpecification] : [];
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    const sp = spec as Record<string, unknown>;
    if (LIST_PRICE_TYPE.test(String(sp.priceType ?? '')) || !isBrl(sp.priceCurrency)) continue;
    const v = parsePrice(sp.price);
    if (v !== undefined) out.push(v);
  }
  if ('offers' in of) collectOfferPrices({ offers: of.offers }, out, depth + 1); // AggregateOffer.offers
}

/** Percorre o JSON-LD em ordem e junta, por nó com "offers", os preços das ofertas daquele nó. */
function collectOfferPrices(node: unknown, out: number[], depth = 0): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const n of node) collectOfferPrices(n, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if ('offers' in o) {
    const offers = Array.isArray(o.offers) ? o.offers : [o.offers];
    for (const offer of offers) if (offer && typeof offer === 'object') pricesOfOffer(offer as Record<string, unknown>, out, depth);
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'offers') collectOfferPrices(v, out, depth + 1);
}

interface OfferGroup { product: boolean; prices: number[] }

/** Listas (produtos relacionados, "compre junto") não são o produto principal, mesmo quando contêm Products. */
const LIST_TYPES = ['ItemList', 'ListItem', 'BreadcrumbList', 'OfferCatalog'];
const PRODUCT_TYPES = ['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel'];

function offerGroups(node: unknown, groups: OfferGroup[], depth = 0, inList = false): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const n of node) offerGroups(n, groups, depth + 1, inList); return; }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  // "https://schema.org/Product", "schema:Product" e "Product" são o mesmo tipo
  const type = (Array.isArray(o['@type']) ? o['@type'] : [o['@type'] ?? '']).map((t) => String(t).replace(/^.*[/#:]/, ''));
  const list = inList || type.some((t) => LIST_TYPES.includes(t));
  if ('offers' in o) {
    const prices: number[] = [];
    collectOfferPrices({ offers: o.offers }, prices);
    if (prices.length) groups.push({ product: !list && type.some((t) => PRODUCT_TYPES.includes(t)), prices });
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'offers') offerGroups(v, groups, depth + 1, list);
}

const minOf = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity);

/**
 * Preço publicado como dado estruturado (como os comparadores fazem: JSON-LD, depois meta e microdata). Vale o primeiro
 * nó do tipo Product e, dentro dele, o menor preço de venda das ofertas disponíveis em BRL. Sem Product, o primeiro grupo
 * de ofertas; sem JSON-LD, o primeiro meta/itemprop.
 */
export function extractGenericPrice(html: string): number | undefined {
  const groups: OfferGroup[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { offerGroups(JSON.parse(m[1].trim()), groups); } catch { /* bloco inválido */ }
  }
  const chosen = groups.find((g) => g.product) ?? groups[0]; // entre todos os blocos da página, em ordem
  if (chosen) return minOf(chosen.prices);
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

/** "R$ 1.299,00", "R$ 1299,50" e também sem centavos ("R$ 3.499"). */
const PRICE_RE = /R\$\s*\d{1,3}(?:\.\d{3})+(?:,\d{2})?|R\$\s*\d+(?:,\d{2})?/g;
const MAX_PRICE_MATCHES = 2000;

/**
 * Até `max` janelas de texto ao redor de valores em R$ (cada uma com `radius` caracteres de cada lado), as mais ligadas
 * às palavras-chave primeiro e sem repetir janelas que se sobrepõem. Cada janela tem tamanho limitado.
 */
export function snippetsAround(text: string, opts: { keywords?: string[]; radius?: number; max?: number } = {}): string[] {
  const radius = opts.radius ?? 300;
  const max = opts.max ?? 3;
  const keywords = (opts.keywords ?? []).map((k) => k.toLowerCase());
  const windows: Array<{ start: number; end: number; score: number; i: number }> = [];
  let n = 0;
  for (const m of text.matchAll(PRICE_RE)) {
    if (n++ >= MAX_PRICE_MATCHES) break;
    const start = Math.max(0, (m.index ?? 0) - radius);
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + radius);
    const lower = text.slice(start, end).toLowerCase();
    windows.push({ start, end, score: keywords.filter((k) => lower.includes(k)).length, i: windows.length });
  }
  windows.sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen: typeof windows = [];
  for (const w of windows) {
    if (chosen.length >= max) break;
    if (chosen.some((c) => w.start < c.end && w.end > c.start)) continue;
    chosen.push(w);
  }
  return chosen.map((w) => text.slice(w.start, w.end).trim());
}
