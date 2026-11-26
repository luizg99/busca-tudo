import type { Finding, Tracker } from '../shared/types';
import type { Usage } from './cost';
import type { FetchResult } from './fetcher';
import { extractGenericPrice } from './html';
import type { LlmClient } from './llm';
import { applyRule, MAX_VARIATION, readSource } from './sources';
import { pageShowsValue } from './teach';
import { isTrustedUrl, normalizeDomain, type ResolveFinalUrl } from './trust';

/** Ofertas cujo preço é conferido na página da loja por verificação (as demais ficam "não conferidas"). */
const MAX_DESTINATION_CHECKS = 30; // trava de segurança contra resposta anormal; na prática a busca traz bem menos

export interface DestinationDeps {
  fetchPage(url: string): Promise<FetchResult>;
  resolve: ResolveFinalUrl;
  llm?: LlmClient;
  model: string;
  tracker: Tracker;
  /** Lista de lojas confiáveis em uso; vazia quando o acompanhamento não restringe lojas. */
  trusted: string[];
}

const BLOG_STALE = (why: string) => `Preço do site de cupom não conferido na loja de destino (${why}); pode estar desatualizado.`;

/**
 * O preço que vale é SEMPRE o da página da loja que vende: um site de cupons ou de ofertas pode estar desatualizado.
 * Para cada oferta, abre a página de destino (a própria página da loja ou o fim do link de compra do site de cupom) e lê
 * o preço do produto lá (dados estruturados; se faltarem, a IA lê só um trecho). O valor que a busca informou fica em
 * `claimedValue`. Oferta de site de cupom que não dá para conferir na loja é ignorada; oferta de loja que não dá para ler
 * (ex.: preço montado por JavaScript) segue com o valor da busca, marcada como `unverified`.
 */
export async function verifyAtDestination(findings: Finding[], d: DestinationDeps): Promise<{ findings: Finding[]; usages: Usage[] }> {
  const usages: Usage[] = [];
  let slot = 0;

  const checkOne = async (f: Finding): Promise<Finding> => {
    if (!f.found || typeof f.value !== 'number' || f.ignoredReason || !f.sourceUrl || !/^https?:\/\//i.test(f.sourceUrl)) return f;
    const sourceHost = normalizeDomain(f.sourceUrl);
    const sourceTrusted = d.trusted.length > 0 && isTrustedUrl(f.sourceUrl, d.trusted);
    // site de cupom/ofertas: o link da loja leva para outro site. Um link de saída no mesmo domínio (/go/produto) pode
    // redirecionar para a loja, então isso só se decide depois de seguir o link.
    let fromAggregator = !!f.via || (!!f.storeUrl && !sourceTrusted);
    const unconfirmed = (why: string): Finding => (fromAggregator ? { ...f, ignoredReason: BLOG_STALE(why) } : { ...f, unverified: true });

    if (slot++ >= MAX_DESTINATION_CHECKS) return unconfirmed('limite de conferências por verificação atingido');

    // onde está o produto na loja
    let dest: string | undefined;
    if (!f.storeUrl || sourceTrusted) dest = f.sourceUrl;
    else if (d.trusted.length > 0 && isTrustedUrl(f.storeUrl, d.trusted)) dest = f.storeUrl;
    else {
      const r = await d.resolve(f.storeUrl);
      if (!r.ok) return unconfirmed(`não consegui seguir o link da loja: ${r.message}`);
      dest = r.finalUrl;
      // o link termina no próprio site da página: então a página já é a da loja
      if (!f.via && normalizeDomain(dest) === sourceHost) fromAggregator = false;
    }

    const page = await d.fetchPage(dest);
    if (!page.ok) return unconfirmed(page.message);

    // na própria página onde a busca viu o preço, a regra que a IA montou lê de graça (sem gastar IA de novo)
    let value = dest === f.sourceUrl && f.priceRegex ? applyRule({ type: 'regex', pattern: f.priceRegex }, page.html) : undefined;
    if (value === undefined) value = extractGenericPrice(page.html);
    // o preço informado está escrito na página da loja: o código confirma, sem gastar IA
    if (value === undefined && pageShowsValue(page.html, f.value)) value = f.value;
    if (value === undefined) {
      const { result, usages: u } = await readSource(
        { fetchPage: async () => page, tracker: d.tracker, llm: d.llm, model: d.model },
        { url: dest, label: f.title },
      );
      usages.push(...u);
      value = result.ok ? result.value : result.suspectValue;
      if (value === undefined) return unconfirmed(result.error ?? 'o preço não aparece na página');
    }

    // leitura muito diferente do informado: pode ser parcela, outro produto ou preço de tabela; não adota às cegas
    if (Math.abs(value - f.value) / f.value > MAX_VARIATION) {
      const brl = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`;
      return unconfirmed(`na loja li ${brl(value)}, muito diferente do informado (${brl(f.value)})`);
    }

    const moved = dest !== f.sourceUrl;
    const destHost = normalizeDomain(dest);
    const { priceRegex: _r, ...rest } = f; // a regra da IA era para a página do site de cupom, não para a da loja
    return {
      ...(moved ? rest : f),
      value,
      sourceUrl: dest,
      ...(moved && sourceHost && sourceHost !== destHost && !f.via ? { via: sourceHost } : {}),
      ...(moved && sourceHost !== destHost ? { viaUrl: f.sourceUrl } : {}),
      ...(Math.abs(value - f.value) / f.value > 0.005 ? { claimedValue: f.value } : {}),
      evidence: `${f.evidence} Preço lido na página da loja.`.trim(),
    };
  };

  const one = async (f: Finding): Promise<Finding> => {
    try {
      return await checkOne(f);
    } catch (e) {
      // um erro de rede numa conferência não derruba a verificação: a oferta fica sem conferência
      const why = (e as Error).message;
      return f.via || f.storeUrl ? { ...f, ignoredReason: BLOG_STALE(why) } : { ...f, unverified: true };
    }
  };

  const checked = await Promise.all(findings.map(one));

  // ofertas que acabaram na mesma página da loja viram uma só; o cupom informado por um site de ofertas é mantido
  // mesma página = mesmo site e caminho (parâmetros de afiliado/rastreio não contam)
  const pageKey = (u: string) => { try { const x = new URL(u); return `${x.hostname}${x.pathname}`; } catch { return u; } };
  const seen = new Map<string, number>();
  const out: Finding[] = [];
  for (const f of checked) {
    if (!f.found || f.ignoredReason || !f.sourceUrl) { out.push(f); continue; }
    const i = seen.get(pageKey(f.sourceUrl));
    if (i === undefined) { seen.set(pageKey(f.sourceUrl), out.length); out.push(f); continue; }
    const p = out[i];
    if (!p.coupon && f.coupon) {
      out[i] = { ...p, coupon: f.coupon, store: p.store ?? f.store, storeUrl: p.storeUrl ?? f.storeUrl, via: p.via ?? f.via, claimedValue: p.claimedValue ?? f.claimedValue, payment: p.payment ?? f.payment, paymentNote: p.paymentNote ?? f.paymentNote };
    }
  }
  return { findings: out, usages };
}
