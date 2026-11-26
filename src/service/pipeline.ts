import type { CheckMode, Finding, SourceResult, Tracker } from '../shared/types';
import { CheckError, runSmartCheck } from './checker';
import { estimateCostUsd, type Usage } from './cost';
import type { Db, SourceRow } from './db';
import { decideAlert } from './decide';
import { fetchPage as defaultFetchPage, type FetchResult } from './fetcher';
import type { LlmClient } from './llm';
import type { Notifier } from './notifier';
import { learnSources, readSource } from './sources';

export interface PipelineDeps {
  db: Db;
  llm: LlmClient;
  notifier: Notifier;
  models: { routine: string; escalate: string };
  now: () => Date;
  /** Baixa páginas (injetável nos testes). */
  fetchPage?: (url: string) => Promise<FetchResult>;
}

export interface CheckResultSummary {
  ok: boolean;
  alerted: boolean;
  baseline: boolean;
  error?: string;
}

/** A busca completa (cara) roda na primeira vez e, depois, no máximo 1 vez por esse intervalo. */
export const DISCOVERY_EVERY_HOURS = 24;
/** Se nenhuma fonte der preço, a busca completa de reserva roda no máximo uma vez por esse intervalo. */
export const FALLBACK_MIN_HOURS = 6;
/** Depois de uma busca completa que falhou, espera esse intervalo antes de tentar outra (evita repetir busca cara a cada verificação). */
export const RETRY_AFTER_FAILED_SEARCH_HOURS = 1;
/** Quantas falhas seguidas de um site antes de avisar no WhatsApp. */
export const WARN_AFTER_FAILURES = 2;
/** Intervalo mínimo entre dois avisos sobre o mesmo site. */
export const WARN_COOLDOWN_HOURS = 24;

/** Acompanhamentos em verificação agora: impede o agendador e o "Verificar agora" de rodarem o mesmo ao mesmo tempo. */
const running = new Set<number>();

export async function runCheck(deps: PipelineDeps, trackerId: number): Promise<CheckResultSummary> {
  if (running.has(trackerId)) {
    return { ok: false, alerted: false, baseline: false, error: 'Verificação já em andamento para este acompanhamento.' };
  }
  running.add(trackerId);
  try {
    return await runCheckLocked(deps, trackerId);
  } finally {
    running.delete(trackerId);
  }
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

/** Resumo do estado atual das fontes, para o histórico da verificação de descoberta. */
function snapshot(sources: SourceRow[]): SourceResult[] {
  return sources.map((s) => (s.status !== 'ok'
    ? { sourceId: s.id, url: s.url, label: s.label, ok: false, error: s.lastError }
    : { sourceId: s.id, url: s.url, label: s.label, ok: true, value: s.lastValue, method: s.rule?.type === 'regex' ? 'rule' : s.rule?.type === 'generic' ? 'generic' : 'ai' }));
}

/** Avisa no WhatsApp sobre sites sem preço (falha repetida ou ilegível), no máximo 1 aviso por site a cada 24 h. */
async function warnProblemSources(deps: PipelineDeps, tracker: Tracker): Promise<void> {
  const { db, notifier, now } = deps;
  const nowMs = now().getTime();
  for (const s of db.listSources(tracker.id)) {
    const problem = s.status === 'unreadable' || (s.status === 'failing' && s.consecutiveFailures >= WARN_AFTER_FAILURES);
    if (!problem) continue;
    if (s.lastNotifiedAt && nowMs - Date.parse(s.lastNotifiedAt) < WARN_COOLDOWN_HOURS * 3600_000) continue;
    const site = s.label || hostOf(s.url);
    const text = [
      `⚠️ ${tracker.name}: não consegui ler o preço em ${site}.`,
      s.status === 'failing' ? `Falhou ${s.consecutiveFailures} verificações seguidas.` : '',
      `Motivo: ${s.lastError ?? 'motivo desconhecido'}`,
      s.url,
      s.status === 'unreadable'
        ? 'Esse site só é visto pela busca completa na web (1 vez por dia).'
        : 'Enquanto ele não voltar, o preço dele só entra pela busca completa na web.',
    ].filter(Boolean).join('\n');
    if (await notifier.sendInfo(text)) db.markSourceNotified(s.id, now().toISOString());
  }
}

async function runCheckLocked(deps: PipelineDeps, trackerId: number): Promise<CheckResultSummary> {
  const { db, llm, notifier, models, now } = deps;
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const tracker = db.getTracker(trackerId);
  if (!tracker) return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento não encontrado.' };
  if (tracker.status !== 'active') return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento pausado.' };

  const at = now().toISOString();
  const lastValue = db.lastValue(trackerId);
  const usages: Usage[] = [];
  let findings: Finding[] = [];
  let sourceResults: SourceResult[] = [];
  let mode: CheckMode = 'discovery';
  let needDiscovery = true;
  const hoursSince = (iso: string) => (now().getTime() - Date.parse(iso)) / 3600_000;
  // busca completa que falhou há pouco: não tenta de novo ainda (só preços; os demais tipos seguem o intervalo do usuário)
  const attempt = tracker.kind === 'price' ? db.lastDiscoveryAttempt(trackerId) : undefined;
  const searchCoolingDown = !!attempt && !attempt.ok && hoursSince(attempt.at) < RETRY_AFTER_FAILED_SEARCH_HOURS;
  const recordFailure = async (error: string): Promise<CheckResultSummary> => {
    const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
    db.addCheck({ trackerId, at, ok: false, error, findings: [], model: usages.at(-1)?.model ?? 'leitura por código', costUsd, mode: 'routine', sources: sourceResults });
    await warnProblemSources(deps, tracker);
    return { ok: false, alerted: false, baseline: false, error };
  };
  const COOLING_MESSAGE = `A busca completa falhou há pouco; nova tentativa em até ${RETRY_AFTER_FAILED_SEARCH_HOURS} hora.`;

  // Preços: depois da descoberta, a rotina lê as fontes conhecidas (plano A = código, plano B = IA com trecho).
  if (tracker.kind === 'price') {
    const readable = db.listSources(trackerId).filter((s) => s.status !== 'unreadable');
    const lastDiscovery = db.lastDiscoveryAt(trackerId);
    const discoveryDue = (!lastDiscovery || hoursSince(lastDiscovery) >= DISCOVERY_EVERY_HOURS) && !searchCoolingDown;
    if (readable.length > 0 && !discoveryDue) {
      mode = 'routine';
      for (const s of readable) {
        const { result, usages: u } = await readSource(
          // cada loja é comparada com o valor ANTERIOR DELA; o valor geral só vale enquanto ela não tem histórico
          { fetchPage, tracker, lastValue: s.lastValue ?? lastValue, llm, model: models.routine },
          { id: s.id, url: s.url, label: s.label, rule: s.rule },
        );
        usages.push(...u);
        sourceResults.push(result);
        db.recordSourceResult(s.id, { ok: result.ok, method: result.method, value: result.value, error: result.error, at });
        if (result.ok && result.value !== undefined) {
          findings.push({
            found: true, value: result.value, currency: 'BRL', title: s.label, sourceUrl: s.url,
            evidence: `Lido da página por ${result.method === 'ai' ? 'IA (trecho)' : 'código'}.`, confidence: result.method === 'ai' ? 0.75 : 0.95,
          });
        }
      }
      if (findings.length > 0) {
        needDiscovery = false;
      } else if (searchCoolingDown) {
        return recordFailure(`Nenhuma fonte deu preço (nem pelo código nem pela IA). ${COOLING_MESSAGE}`);
      } else if (!lastDiscovery || hoursSince(lastDiscovery) >= FALLBACK_MIN_HOURS) {
        mode = 'fallback'; // nenhuma fonte deu preço: busca completa de reserva (limitada a 1 vez por FALLBACK_MIN_HOURS)
      } else {
        // reserva recente: não repete a busca cara; registra a falha (e a contagem das fontes segue para o aviso)
        return recordFailure(`Nenhuma fonte deu preço (nem pelo código nem pela IA). A busca completa de reserva roda no máximo a cada ${FALLBACK_MIN_HOURS} horas.`);
      }
    }
  }

  if (needDiscovery) {
    if (searchCoolingDown) return recordFailure(COOLING_MESSAGE);
    let outcome;
    try {
      outcome = await runSmartCheck(llm, tracker, models);
    } catch (e) {
      const error = (e as Error).message;
      if (e instanceof CheckError) usages.push(...e.usages);
      const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
      db.addCheck({ trackerId, at, ok: false, error, findings: [], model: usages.at(-1)?.model ?? models.routine, costUsd, mode, sources: sourceResults });
      await warnProblemSources(deps, tracker);
      return { ok: false, alerted: false, baseline: false, error };
    }
    usages.push(...outcome.usages);
    findings = outcome.findings;
    if (tracker.kind === 'price') {
      await learnSources({ db, fetchPage }, tracker, findings);
      if (mode === 'discovery') sourceResults = snapshot(db.listSources(trackerId));
    }
  }

  const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
  const last = db.lastAlert(trackerId);
  const decision = decideAlert(tracker, findings, {
    lastValue,
    isNew: (key) => db.markSeen(trackerId, key),
    lastAlertAt: last?.at,
    lastAlertSourceUrl: last?.sourceUrl,
    lastAlertValue: last?.value,
    now: at,
  });

  db.addCheck({ trackerId, at, ok: true, findings, model: usages.at(-1)?.model ?? 'leitura por código', costUsd, mode, sources: sourceResults });

  if (decision.alert) {
    await notifier.send(trackerId, decision.alert.text, { sourceUrl: decision.alert.sourceUrl, value: decision.alert.value });
  }
  if (tracker.kind === 'price') await warnProblemSources(deps, tracker);
  return { ok: true, alerted: !!decision.alert, baseline: decision.baseline };
}
