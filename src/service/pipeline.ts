import { CheckError, runSmartCheck } from './checker';
import { estimateCostUsd } from './cost';
import type { Db } from './db';
import { decideAlert } from './decide';
import type { LlmClient } from './llm';
import type { Notifier } from './notifier';

export interface PipelineDeps {
  db: Db;
  llm: LlmClient;
  notifier: Notifier;
  models: { routine: string; escalate: string };
  now: () => Date;
}

export interface CheckResultSummary {
  ok: boolean;
  alerted: boolean;
  baseline: boolean;
  error?: string;
}

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

async function runCheckLocked(deps: PipelineDeps, trackerId: number): Promise<CheckResultSummary> {
  const { db, llm, notifier, models, now } = deps;
  const tracker = db.getTracker(trackerId);
  if (!tracker) return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento não encontrado.' };
  if (tracker.status !== 'active') return { ok: false, alerted: false, baseline: false, error: 'Acompanhamento pausado.' };

  const at = now().toISOString();
  let outcome;
  try {
    outcome = await runSmartCheck(llm, tracker, models);
  } catch (e) {
    const error = (e as Error).message;
    const usages = e instanceof CheckError ? e.usages : [];
    const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
    db.addCheck({ trackerId, at, ok: false, error, findings: [], model: usages.at(-1)?.model ?? models.routine, costUsd });
    return { ok: false, alerted: false, baseline: false, error };
  }

  const costUsd = outcome.usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);
  const model = outcome.usages[outcome.usages.length - 1].model;
  const last = db.lastAlert(trackerId);
  const decision = decideAlert(tracker, outcome.findings, {
    lastValue: db.lastValue(trackerId),
    isNew: (key) => db.markSeen(trackerId, key),
    lastAlertAt: last?.at,
    lastAlertSourceUrl: last?.sourceUrl,
    lastAlertValue: last?.value,
    now: at,
  });

  db.addCheck({ trackerId, at, ok: true, findings: outcome.findings, model, costUsd });

  if (decision.alert) {
    await notifier.send(trackerId, decision.alert.text, { sourceUrl: decision.alert.sourceUrl, value: decision.alert.value });
  }
  return { ok: true, alerted: !!decision.alert, baseline: decision.baseline };
}
