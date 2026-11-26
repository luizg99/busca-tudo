import { parsePrice } from './decide';

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Texto visível aproximado da página: sem script/style/comentários/tags, entidades decodificadas, espaços compactados. */
export function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noBlocks.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

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

/** Preço publicado como dado estruturado (JSON-LD, meta tags ou microdata). Devolve o menor encontrado. */
export function extractGenericPrice(html: string): number | undefined {
  const prices: number[] = [];

  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectOfferPrices(JSON.parse(m[1].trim()), prices); } catch { /* bloco inválido */ }
  }
  for (const m of html.matchAll(/<meta[^>]+(?:product:price:amount|og:price:amount)[^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    const v = c ? parsePrice(c[1]) : undefined;
    if (v !== undefined) prices.push(v);
  }
  for (const m of html.matchAll(/<[^>]+itemprop=["']price["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    const v = c ? parsePrice(c[1]) : undefined;
    if (v !== undefined) prices.push(v);
  }
  return prices.length ? Math.min(...prices) : undefined;
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
