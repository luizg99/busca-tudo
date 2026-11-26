import type { Finding, Tracker } from '../shared/types';
import type { Usage } from './cost';
import { MIN_CONFIDENCE, parsePrice } from './decide';
import type { LlmClient } from './llm';

export class CheckError extends Error {
  constructor(message: string) {
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
{"findings":[{"found":true|false,"value":<número, sem símbolo de moeda>,"currency":"BRL","title":"...","source_url":"https://...","evidence":"por que este resultado vale","confidence":<0 a 1>}]}
Se nada relevante for encontrado, responda {"findings":[{"found":false,"evidence":"o que foi procurado","confidence":0.9}]}.
"confidence" reflete o quanto você tem certeza de que o resultado atende ao objetivo e aos critérios.`;

function buildPrompt(t: Tracker): string {
  const lines = [`Acompanhamento: ${t.name}`, `Tipo: ${t.kind}`, `Objetivo: ${t.goal}`];
  if (t.include.length) lines.push(`Deve incluir/considerar: ${t.include.join('; ')}`);
  if (t.exclude.length) lines.push(`Deve excluir/ignorar: ${t.exclude.join('; ')}`);
  lines.push(
    t.kind === 'news'
      ? 'Liste as notícias/publicações recentes relevantes (title e source_url obrigatórios, sem value).'
      : 'Informe o menor valor atual confiável (value numérico) com a fonte.',
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

function normalize(raw: any): Finding {
  const value = raw.value === undefined || raw.value === null ? undefined : parsePrice(raw.value);
  const confidence = Math.min(1, Math.max(0, Number(raw.confidence) || 0));
  return {
    found: raw.found === true,
    ...(value !== undefined ? { value } : {}),
    ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.source_url === 'string' ? { sourceUrl: raw.source_url } : {}),
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
    confidence,
  };
}

async function once(llm: LlmClient, t: Tracker, model: string): Promise<{ findings: Finding[]; usage: Usage }> {
  let res;
  try {
    res = await llm.search({ model, system: SYSTEM, prompt: buildPrompt(t) });
  } catch (e) {
    throw new CheckError(`Falha ao consultar a IA: ${(e as Error).message}`);
  }
  const json: any = extractJson(res.text);
  if (!json || !Array.isArray(json.findings)) throw new CheckError('Resposta da IA sem a lista "findings".');
  return { findings: json.findings.map(normalize), usage: res.usage };
}

function lowConfidence(findings: Finding[]): boolean {
  const found = findings.filter((f) => f.found);
  return found.length > 0 && Math.max(...found.map((f) => f.confidence)) < MIN_CONFIDENCE;
}

export async function runSmartCheck(
  llm: LlmClient,
  t: Tracker,
  models: { routine: string; escalate: string },
): Promise<CheckOutcome> {
  const first = await once(llm, t, models.routine);
  if (!lowConfidence(first.findings)) return { findings: first.findings, usages: [first.usage], escalated: false };
  const second = await once(llm, t, models.escalate);
  return { findings: second.findings, usages: [first.usage, second.usage], escalated: true };
}
