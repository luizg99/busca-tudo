import type { Finding, Tracker } from '../shared/types';
import type { Usage } from './cost';
import { MIN_CONFIDENCE, parsePrice } from './decide';
import { DEFAULT_TARGET_SITES, searchBudget } from './target';
import type { LlmClient } from './llm';

export class CheckError extends Error {
  /** Uso (e portanto custo) das chamadas já feitas antes da falha. */
  constructor(message: string, public usages: Usage[] = []) {
    super(message);
    this.name = 'CheckError';
  }
}

export interface CheckOutcome {
  findings: Finding[];
  /** Uma entrada por chamada ao modelo (custos diferem por modelo). */
  usages: Usage[];
  escalated: boolean;
}

const SYSTEM = `Você é um verificador de acompanhamentos que pesquisa na web e responde SOMENTE com JSON.

Método:
1. Planeje várias consultas de busca: variações de termos, sinônimos e lojas/fontes relevantes. Não confie na primeira busca.
2. Cruze pelo menos 2 fontes sempre que possível e prefira fontes confiáveis.
3. Descarte resultados que violem os critérios (outro modelo, usado, anúncio suspeito, preço implausível).
4. Responda apenas com JSON no formato:
{"findings":[{"found":true|false,"value":<número, sem símbolo de moeda>,"currency":"BRL","title":"...","source_url":"https://...","evidence":"por que este resultado vale, em uma frase curta","confidence":<0 a 1>,"price_regex":"...","store":"loja que vende","store_url":"https://...","coupon":"cupom e condições","payment":"vista"|"parcelado","payment_note":"Pix"}]}
Se nada relevante for encontrado, responda {"findings":[{"found":false,"evidence":"o que foi procurado","confidence":0.9}]}.
"price_regex" é uma expressão regular (sintaxe JavaScript, sem barras, case-insensitive) com UM grupo de captura, aplicada ao TEXTO visível da página (sem HTML), que captura o preço do produto exatamente como escrito na página, ancorada no nome do produto ou em palavras próximas (ex.: "Digital.{0,40}?R\\$\\s*([\\d.,]+)\\s*no pix"). Lembre de escapar as barras invertidas no JSON. Use null se não tiver certeza.
"store" é a LOJA que vende o produto (pode ser diferente do site onde você viu a oferta, por exemplo um blog de cupons). "store_url" é o link final da loja para esse produto (ou o link de saída do site, se for um agregador). "coupon" só se a oferta depender de cupom: código e condições (ex.: "PROMOAGORA, pagamento no Pix"). "value" é sempre o preço TOTAL do produto (nunca o valor de uma parcela). "payment" diz como esse valor é pago: "vista" (à vista: Pix, boleto ou débito) ou "parcelado" (só no cartão parcelado, sem preço à vista menor); "payment_note" é CURTO, no máximo 3 palavras, sem frases nem parênteses (ex.: "Pix", "10x sem juros", "Boleto"). Omita os campos que não se aplicam.
"confidence" reflete o quanto você tem certeza de que o resultado atende ao objetivo e aos critérios.`;

/** Instruções para buscar em lojas confiáveis sem ignorar sites desconhecidos que trazem cupom de loja confiável. */
function trustedBlock(sites: string[]): string {
  return [
    `Lojas confiáveis (prioridade): ${sites.join(', ')}.`,
    'Priorize preços dessas lojas. NÃO ignore sites desconhecidos (blogs, agregadores de ofertas e cupons) quando a oferta deles for de uma loja confiável: ' +
      'nesse caso informe em "store" o nome da loja, em "store_url" o link final da loja (ou o link de saída do site) e em "coupon" o cupom e as condições. ' +
      'Não informe ofertas de lojas fora da lista, a menos que a oferta seja claramente de uma loja confiável.',
  ].join('\n');
}

function buildPrompt(t: Tracker, trustedSites: string[] = [], targetSites = DEFAULT_TARGET_SITES): string {
  const lines = [`Acompanhamento: ${t.name}`, `Tipo: ${t.kind}`, `Objetivo: ${t.goal}`];
  if (t.kind === 'price' && t.onlyTrusted && trustedSites.length > 0) lines.push(trustedBlock(trustedSites));
  if (t.kind === 'price') {
    lines.push(
      `Meta: reunir cerca de ${targetSites} ofertas de sites ou lojas diferentes (uma por site/página, sem repetir), incluindo lojas, sites de ofertas e blogs. ` +
      'Procure em várias lojas diferentes do mesmo produto e também em sites de ofertas e cupons (como Promobit e Pelando), ' +
      'em comparadores e em blogs de ofertas, que costumam trazer promoções e cupons de lojas conhecidas. Use consultas distintas ' +
      'para cobrir mais fontes (loja por loja e ofertas do dia), em vez de repetir a mesma busca.',
    );
  }
  if (t.include.length) lines.push(`Deve incluir/considerar: ${t.include.join('; ')}`);
  if (t.exclude.length) lines.push(`Deve excluir/ignorar: ${t.exclude.join('; ')}`);
  lines.push(
    t.kind === 'news'
      ? 'Liste as notícias/publicações recentes relevantes (title e source_url obrigatórios, sem value).'
      : 'Liste TODAS as ofertas confiáveis que encontrar, uma por loja/página (não só a mais barata): cada achado com seu valor atual (value numérico) e a fonte. Quanto mais lojas diferentes, melhor, mesmo que o preço não seja o menor.',
  );
  return lines.join('\n');
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), text];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      /* tenta o próximo */
    }
  }
  throw new CheckError('Resposta da IA não é um JSON válido.');
}

/** Observação de pagamento curta: só o começo (antes de parênteses, ponto e vírgula ou vírgula), no máximo 30 caracteres. */
export function shortNote(note: string): string {
  const first = note.split(/[(;,]/)[0].trim();
  return first.length > 30 ? `${first.slice(0, 29).trimEnd()}…` : first;
}

function normalize(raw: any): Finding {
  const value = raw.value === undefined || raw.value === null ? undefined : parsePrice(raw.value);
  const confidence = Math.min(1, Math.max(0, Number(raw.confidence) || 0));
  return {
    found: raw.found === true,
    ...(value !== undefined ? { value } : {}),
    ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.source_url === 'string' ? { sourceUrl: raw.source_url } : {}),
    ...(typeof raw.price_regex === 'string' && raw.price_regex.length > 0 && raw.price_regex.length <= 400 ? { priceRegex: raw.price_regex } : {}),
    ...(typeof raw.store === 'string' && raw.store.trim() ? { store: raw.store.trim().slice(0, 120) } : {}),
    ...(typeof raw.store_url === 'string' && /^https?:\/\//i.test(raw.store_url) ? { storeUrl: raw.store_url } : {}),
    ...(raw.payment === 'vista' || raw.payment === 'parcelado' ? { payment: raw.payment as 'vista' | 'parcelado' } : {}),
    ...(typeof raw.payment_note === 'string' && raw.payment_note.trim() ? { paymentNote: shortNote(raw.payment_note) } : {}),
    ...(typeof raw.coupon === 'string' && raw.coupon.trim() ? { coupon: raw.coupon.trim().slice(0, 200) } : {}),
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
    confidence,
  };
}

async function once(llm: LlmClient, t: Tracker, model: string, trustedSites: string[], targetSites?: number): Promise<{ findings: Finding[]; usage: Usage }> {
  let res;
  try {
    res = await llm.search({
      model, system: SYSTEM, prompt: buildPrompt(t, trustedSites, targetSites),
      // preço: mais pesquisas para cobrir a meta de sites; notícias seguem com o padrão
      ...(t.kind === 'price' ? { maxSearches: searchBudget(targetSites ?? DEFAULT_TARGET_SITES) } : {}),
    });
  } catch (e) {
    throw new CheckError(`Falha ao consultar a IA: ${(e as Error).message}`);
  }
  try {
    const json: any = extractJson(res.text);
    if (!json || !Array.isArray(json.findings)) throw new CheckError('Resposta da IA sem a lista "findings".');
    return { findings: json.findings.map(normalize), usage: res.usage };
  } catch (e) {
    throw new CheckError((e as Error).message, [res.usage]);
  }
}

function lowConfidence(findings: Finding[]): boolean {
  const found = findings.filter((f) => f.found);
  return found.length > 0 && Math.max(...found.map((f) => f.confidence)) < MIN_CONFIDENCE;
}

export async function runSmartCheck(
  llm: LlmClient,
  t: Tracker,
  models: { routine: string; escalate: string },
  opts: { trustedSites?: string[]; targetSites?: number } = {},
): Promise<CheckOutcome> {
  const trusted = opts.trustedSites ?? [];
  const first = await once(llm, t, models.routine, trusted, opts.targetSites);
  if (!lowConfidence(first.findings)) return { findings: first.findings, usages: [first.usage], escalated: false };
  let second;
  try {
    second = await once(llm, t, models.escalate, trusted, opts.targetSites);
  } catch (e) {
    throw new CheckError((e as Error).message, [first.usage, ...((e as CheckError).usages ?? [])]);
  }
  return { findings: second.findings, usages: [first.usage, second.usage], escalated: true };
}
