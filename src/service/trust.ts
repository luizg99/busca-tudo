import type { Finding } from '../shared/types';
import type { Db } from './db';

/**
 * Lojas conhecidas, usadas quando o usuário ainda não montou a própria lista (editável em Configurações).
 * Domínios cobrem subdomínios (www., smile. etc.).
 */
export const DEFAULT_TRUSTED_SITES = [
  'amazon.com.br',
  'mercadolivre.com.br',
  'magazineluiza.com.br',
  'magalu.com',
  'kabum.com.br',
  'americanas.com.br',
  'submarino.com.br',
  'shoptime.com.br',
  'casasbahia.com.br',
  'pontofrio.com.br',
  'extra.com.br',
  'novomundo.com.br',
  'fastshop.com.br',
  'pichau.com.br',
  'terabyteshop.com.br',
  'carrefour.com.br',
  'girafa.com.br',
  'kalunga.com.br',
  'leroymerlin.com.br',
];

/** "https://www.Amazon.com.br/dp/X" → "amazon.com.br". Devolve undefined se não parecer um domínio. */
export function normalizeDomain(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : undefined;
}

/** Limpa uma lista digitada: domínios normalizados, sem lixo e sem duplicados, na ordem em que vieram. */
export function normalizeTrustedList(list: unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const d = normalizeDomain(item);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

export function domainMatches(host: string, trusted: string[]): boolean {
  return trusted.some((d) => host === d || host.endsWith(`.${d}`));
}

/** O endereço pertence a uma loja confiável? Subdomínios contam; sufixos enganosos (evilamazon.com.br) não. */
export function isTrustedUrl(url: string, trusted: string[]): boolean {
  const host = normalizeDomain(url);
  return !!host && domainMatches(host, trusted);
}

/** Lista configurada em Configurações; sem configuração, usa a lista padrão. */
export function getTrustedSites(db: Db): string[] {
  const raw = db.getSetting('trusted_sites');
  if (raw === undefined) return DEFAULT_TRUSTED_SITES;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeTrustedList(parsed) : DEFAULT_TRUSTED_SITES;
  } catch {
    return DEFAULT_TRUSTED_SITES;
  }
}

export type TrustVerdict =
  | { verdict: 'trusted' }
  | { verdict: 'via_trusted'; via: string }
  | { verdict: 'ignored'; reason: string };

export type ResolveFinalUrl = (url: string) => Promise<{ ok: true; finalUrl: string } | { ok: false; message: string }>;

/**
 * Vale a LOJA QUE VENDE, não o site onde a oferta foi vista. Oferta numa página de loja confiável vale. Numa página
 * desconhecida (blog, agregador de cupom) só vale se o link da loja levar a uma loja confiável, conferido de verdade
 * (seguindo os redirecionamentos do link de saída): o nome da loja citado só no texto não basta.
 */
/** Endereços (href) de uma página, absolutos e sem fragmento. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"'\s>]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 1000) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      out.push(u.href);
    } catch { /* link inválido: ignora */ }
  }
  return out;
}

/** Links da página de um site desconhecido, para conferir o que a IA afirmou; undefined = não deu para abrir. */
export type PageLinks = (pageUrl: string) => Promise<string[] | undefined>;

export async function classifyFinding(f: Finding, trusted: string[], resolve: ResolveFinalUrl, pageLinks?: PageLinks): Promise<TrustVerdict> {
  if (!f.sourceUrl) return { verdict: 'ignored', reason: 'Oferta sem endereço de origem para conferir.' };
  if (isTrustedUrl(f.sourceUrl, trusted)) return { verdict: 'trusted' };

  const via = normalizeDomain(f.sourceUrl) ?? f.sourceUrl;
  if (!f.storeUrl) {
    return { verdict: 'ignored', reason: `Site desconhecido (${via}) e a loja${f.store ? ` (${f.store})` : ''} é citada sem link para conferir.` };
  }
  // o endereço da loja vem da IA: confere na própria página do site desconhecido (e não só no que a IA disse)
  let links: string[] | undefined;
  if (pageLinks) {
    links = await pageLinks(f.sourceUrl);
    if (!links) return { verdict: 'ignored', reason: `Não consegui abrir a página de ${via} para conferir o link da loja.` };
  }
  if (isTrustedUrl(f.storeUrl, trusted)) {
    if (links && !links.some((l) => isTrustedUrl(l, trusted))) {
      return { verdict: 'ignored', reason: `A página de ${via} não tem link para uma loja confiável.` };
    }
    return { verdict: 'via_trusted', via };
  }
  if (links) {
    let wanted: string;
    try { const u = new URL(f.storeUrl); u.hash = ''; wanted = u.href; } catch { wanted = f.storeUrl; }
    if (!links.includes(wanted)) return { verdict: 'ignored', reason: `O link da loja não aparece na página de ${via}.` };
  }

  const r = await resolve(f.storeUrl);
  if (!r.ok) return { verdict: 'ignored', reason: `Não consegui conferir o link da loja em ${via}: ${r.message}` };
  if (isTrustedUrl(r.finalUrl, trusted)) return { verdict: 'via_trusted', via };
  return { verdict: 'ignored', reason: `O link de saída de ${via} não leva a uma loja confiável (termina em ${normalizeDomain(r.finalUrl) ?? r.finalUrl}).` };
}
