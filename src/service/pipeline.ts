import type { CheckMode, Finding, SourceResult, Tracker } from '../shared/types';
import { CheckError, runSmartCheck } from './checker';
import { estimateCostUsd, type Usage } from './cost';
import type { Db, SourceRow } from './db';
import { decideAlert } from './decide';
import { fetchPage as defaultFetchPage, resolveFinalUrl as defaultResolveFinalUrl, type FetchResult } from './fetcher';
import type { LlmClient } from './llm';
import type { Notifier } from './notifier';
import { learnSources, readSource } from './sources';
import { verifyAtDestination } from './destination';
import { classifyFinding, extractLinks, getTrustedSites, isTrustedUrl, type PageLinks, type ResolveFinalUrl } from './trust';

/** Cada conferência de link de saída espera pouco: são várias em paralelo e a verificação inteira não pode travar. */
const TRUST_RESOLVE_TIMEOUT_MS = 6000;

/** Ofertas conferidas (com seguimento de link) por busca completa. */
const MAX_TRUST_CHECKS = 8;

/**
 * Aplica a lista de lojas confiáveis às ofertas da busca: ofertas de loja desconhecida ficam marcadas como ignoradas
 * (com o motivo) e continuam no histórico; ofertas achadas num site desconhecido, mas de loja confiável, ganham `via`.
 */
async function applyTrust(findings: Finding[], trusted: string[], resolve: ResolveFinalUrl, pageLinks: PageLinks): Promise<Finding[]> {
  // só as ofertas que exigem rede (site desconhecido) entram no limite; as de loja confiável nunca são descartadas por ele
  const needsNetwork = (f: Finding) => f.found && typeof f.value === 'number' && !f.ignoredReason && !!f.sourceUrl && !isTrustedUrl(f.sourceUrl, trusted);
  let slot = 0;
  return Promise.all(findings.map(async (f): Promise<Finding> => {
    if (!f.found || typeof f.value !== 'number' || f.ignoredReason) return f;
    if (needsNetwork(f) && slot++ >= MAX_TRUST_CHECKS) return { ...f, ignoredReason: 'Limite de ofertas conferidas por verificação atingido.' };
    try {
      const v = await classifyFinding(f, trusted, resolve, pageLinks);
      return v.verdict === 'ignored' ? { ...f, ignoredReason: v.reason } : v.verdict === 'via_trusted' ? { ...f, via: v.via } : f;
    } catch (e) {
      return { ...f, ignoredReason: `Não consegui conferir a loja: ${(e as Error).message}` };
    }
  }));
}

export interface PipelineDeps {
  db: Db;
  llm: LlmClient;
  notifier: Notifier;
  models: { routine: string; escalate: string };
  now: () => Date;
  /** Baixa páginas (injetável nos testes). */
  fetchPage?: (url: string) => Promise<FetchResult>;
  /** Segue o link de saída de um site desconhecido para conferir a loja (injetável nos testes). */
  resolveFinalUrl?: ResolveFinalUrl;
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
/** Depois de uma busca que falhou, o botão "Verificar agora" espera esse tempo (evita pagar várias buscas por cliques repetidos). */
export const MANUAL_RETRY_MINUTES = 2;
/** Quantas falhas seguidas de um site antes de avisar no WhatsApp. */
export const WARN_AFTER_FAILURES = 2;
/**
 * Um aviso por episódio de problema de um site. Se uma FALHA continuar por mais que isso, vem um lembrete. Site que o
 * código não lê (ilegível) avisa uma vez só. Voltar a funcionar encerra o episódio.
 */
export const WARN_REMINDER_DAYS = 7;
/** Uma leitura fora do esperado só pede a busca completa de confirmação se a última foi há mais que isso. */
export const SUSPECT_CONFIRM_MIN_HOURS = 1;
/** Valores de fontes sem leitura boa há mais que isso deixam de servir de referência para o alerta. */
const BASELINE_STALE_HOURS = 48;

/** Acompanhamentos em verificação agora: impede o agendador e o "Verificar agora" de rodarem o mesmo ao mesmo tempo. */
const running = new Set<number>();

export interface RunOptions {
  /** Verificação pedida pelo usuário ("Verificar agora"): ignora a espera depois de uma busca completa que falhou. */
  manual?: boolean;
}

export async function runCheck(deps: PipelineDeps, trackerId: number, opts: RunOptions = {}): Promise<CheckResultSummary> {
  if (running.has(trackerId)) {
    return { ok: false, alerted: false, baseline: false, error: 'Verificação já em andamento para este acompanhamento.' };
  }
  running.add(trackerId);
  try {
    return await runCheckLocked(deps, trackerId, opts);
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

/** Avisa no WhatsApp sobre sites sem preço (falha repetida ou ilegível): um aviso por episódio, com lembrete só depois de 7 dias. */
async function warnProblemSources(deps: PipelineDeps, tracker: Tracker): Promise<void> {
  const { db, notifier, now } = deps;
  const nowMs = now().getTime();
  for (const s of db.listSources(tracker.id)) {
    const problem = s.status === 'unreadable' || (s.status === 'failing' && s.consecutiveFailures >= WARN_AFTER_FAILURES);
    if (!problem) continue;
    if (s.lastNotifiedAt) {
      if (s.status === 'unreadable') continue; // ilegível avisa uma vez só
      if (nowMs - Date.parse(s.lastNotifiedAt) < WARN_REMINDER_DAYS * 86_400_000) continue; // falha: lembrete só depois de dias
    }
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

async function runCheckLocked(deps: PipelineDeps, trackerId: number, opts: RunOptions): Promise<CheckResultSummary> {
  const { db, llm, notifier, models, now } = deps;
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const tracker = db.getTracker(trackerId);
  if (!tracker) return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento não encontrado.' };
  if (tracker.status !== 'active') return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento pausado.' };

  const at = now().toISOString();
  const lastValue = db.lastValue(trackerId);
  // "Só lojas confiáveis": vale a loja que vende. Lista vazia = sem restrição. Só para preços.
  const trustedSites = tracker.kind === 'price' && tracker.onlyTrusted ? getTrustedSites(db) : [];
  const filterByTrust = trustedSites.length > 0;
  const trustedOk = (s: SourceRow) => !filterByTrust || isTrustedUrl(s.url, trustedSites) || !!s.trustedVia;
  const usages: Usage[] = [];
  let findings: Finding[] = [];
  let sourceResults: SourceResult[] = [];
  let mode: CheckMode = 'discovery';
  let needDiscovery = true;
  const hoursSince = (iso: string) => (now().getTime() - Date.parse(iso)) / 3600_000;
  // Referência do alerta "abaixo do último valor": o MENOR valor que as fontes mostravam por último, e não só o do check
  // anterior (que pode ter perdido uma loja por falha passageira e dar alerta falso quando ela volta).
  const baseline = (() => {
    if (tracker.kind !== 'price') return lastValue;
    const vals = db.listSources(trackerId)
      .filter((s) => s.status !== 'unreadable' && trustedOk(s) && s.lastValue !== undefined && (!s.lastOkAt || hoursSince(s.lastOkAt) < BASELINE_STALE_HOURS))
      .map((s) => s.lastValue as number);
    return vals.length ? vals.reduce((a, b) => (b < a ? b : a)) : lastValue;
  })();
  // busca completa que falhou há pouco: não tenta de novo ainda (só preços; os demais tipos seguem o intervalo do usuário)
  const attempt = tracker.kind === 'price' ? db.lastDiscoveryAttempt(trackerId) : undefined;
  // agendada: espera 1 h depois de uma busca que falhou; manual (ação do usuário): só uma espera curta contra cliques repetidos
  const cooldownHours = opts.manual ? MANUAL_RETRY_MINUTES / 60 : RETRY_AFTER_FAILED_SEARCH_HOURS;
  const searchCoolingDown = !!attempt && !attempt.ok && hoursSince(attempt.at) < cooldownHours;
  const recordFailure = async (error: string): Promise<CheckResultSummary> => {
    const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
    db.addCheck({ trackerId, at, ok: false, error, findings: [], model: usages.at(-1)?.model ?? 'leitura por código', costUsd, mode: 'routine', sources: sourceResults });
    await warnProblemSources(deps, tracker);
    return { ok: false, alerted: false, baseline: false, error };
  };
  const COOLING_MESSAGE = opts.manual
    ? `A busca completa falhou há pouco; aguarde ${MANUAL_RETRY_MINUTES} minutos para tentar de novo.`
    : `A busca completa falhou há pouco; nova tentativa em até ${RETRY_AFTER_FAILED_SEARCH_HOURS} hora.`;

  // Preços: depois da descoberta, a rotina lê as fontes conhecidas (plano A = código, plano B = IA com trecho).
  if (tracker.kind === 'price') {
    // fonte de loja desconhecida (ex.: aprendida antes da lista de confiáveis) não conta: sem fontes válidas, a busca completa refaz
    const known = db.listSources(trackerId).filter(trustedOk);
    const readable = known.filter((s) => s.status !== 'unreadable');
    const lastDiscovery = db.lastDiscoveryAt(trackerId);
    const discoveryDue = (!lastDiscovery || hoursSince(lastDiscovery) >= DISCOVERY_EVERY_HOURS) && !searchCoolingDown;
    let anySuspect = false;
    if (readable.length === 0 && known.length > 0 && !discoveryDue) {
      // só há fontes que o código não lê: só a busca completa diária as vê, então isto não é falha nem gera custo
      db.addCheck({ trackerId, at, ok: true, findings: [], model: 'leitura por código', costUsd: 0, mode: 'routine', sources: snapshot(known) });
      await warnProblemSources(deps, tracker);
      return { ok: true, alerted: false, baseline: false };
    }
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
        // leitura fora do esperado é "suspeita": não conta como falha da loja (a busca completa decide se é queda real)
        if (result.suspectValue !== undefined) anySuspect = true;
        else db.recordSourceResult(s.id, { ok: result.ok, method: result.method, value: result.value, error: result.error, at });
        if (result.ok && result.value !== undefined) {
          findings.push({
            found: true, value: result.value, currency: 'BRL', title: s.label, sourceUrl: s.url,
            ...(s.origin ? { via: s.origin.via, store: s.origin.store, storeUrl: s.origin.storeUrl, coupon: s.origin.coupon, payment: s.origin.payment, paymentNote: s.origin.paymentNote } : {}),
            evidence: `Lido da página por ${result.method === 'ai' ? 'IA (trecho)' : 'código'}.`, confidence: result.method === 'ai' ? 0.75 : 0.95,
          });
        }
      }
      if (findings.length > 0) {
        needDiscovery = false;
        // uma loja leu um valor muito diferente (possível queda grande, ex.: Black Friday): a busca completa confirma
        if (anySuspect && !searchCoolingDown && (!lastDiscovery || hoursSince(lastDiscovery) >= SUSPECT_CONFIRM_MIN_HOURS)) {
          needDiscovery = true;
          mode = 'fallback';
        }
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
    if (searchCoolingDown) {
      // clique manual dentro da espera: nada foi lido nem buscado, então só devolve a mensagem (sem histórico nem avisos)
      if (opts.manual && sourceResults.length === 0) return { ok: false, alerted: false, baseline: false, error: COOLING_MESSAGE };
      return recordFailure(COOLING_MESSAGE);
    }
    let outcome;
    try {
      outcome = await runSmartCheck(llm, tracker, models, { trustedSites });
    } catch (e) {
      const error = (e as Error).message;
      if (e instanceof CheckError) usages.push(...e.usages);
      const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
      db.addCheck({ trackerId, at, ok: false, error, findings: [], model: usages.at(-1)?.model ?? models.routine, costUsd, mode, sources: sourceResults });
      await warnProblemSources(deps, tracker);
      return { ok: false, alerted: false, baseline: false, error };
    }
    usages.push(...outcome.usages);
    if (filterByTrust) {
      const cache = new Map<string, Promise<string[] | undefined>>();
      const pageLinks: PageLinks = (url) => {
        let p = cache.get(url);
        if (!p) { p = fetchPage(url).then((r) => (r.ok ? extractLinks(r.html, url) : undefined), () => undefined); cache.set(url, p); }
        return p;
      };
      const resolve = deps.resolveFinalUrl ?? ((u: string) => defaultResolveFinalUrl(u, { timeoutMs: TRUST_RESOLVE_TIMEOUT_MS }));
      findings = await applyTrust(outcome.findings, trustedSites, resolve, pageLinks);
    } else {
      findings = outcome.findings;
    }
    if (tracker.kind === 'price') {
      // o preço que vale é o da página da loja de destino (site de cupom pode estar desatualizado)
      const cacheResolve = deps.resolveFinalUrl ?? ((u: string) => defaultResolveFinalUrl(u, { timeoutMs: TRUST_RESOLVE_TIMEOUT_MS }));
      const verified = await verifyAtDestination(findings, { fetchPage, resolve: cacheResolve, llm, model: models.routine, tracker, trusted: trustedSites });
      findings = verified.findings;
      usages.push(...verified.usages);
    }
    if (tracker.kind === 'price') {
      // aprender fontes é um extra: um erro aqui não pode perder o check nem o custo da busca (e causar nova busca em seguida)
      try { await learnSources({ db, fetchPage }, tracker, findings); } catch { /* segue sem aprender desta vez */ }
      if (mode === 'discovery') sourceResults = snapshot(db.listSources(trackerId));
    }
  }

  const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
  const last = db.lastAlert(trackerId);
  const decision = decideAlert(tracker, findings, {
    lastValue: baseline,
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
