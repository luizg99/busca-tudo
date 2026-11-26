import type { Db } from './db';
import type { LlmClient } from './llm';
import type { Notifier } from './notifier';

export interface TrackerStats {
  trackerId: number;
  checks: number;
  failures: number;
  min?: number;
  max?: number;
  avg?: number;
  alerts: number;
  relevant: Array<{ at: string; title?: string; value?: number; sourceUrl?: string }>;
}

export type DigestPeriod = 'daily' | 'weekly';

export function computeStats(db: Db, trackerId: number, fromIso: string, toIso: string): TrackerStats {
  const checks = db.listChecksBetween(trackerId, fromIso, toIso);
  const values: number[] = [];
  for (const c of checks) {
    if (!c.ok) continue;
    const vals = c.findings.filter((x) => x.found && typeof x.value === 'number').map((x) => x.value as number);
    if (vals.length) values.push(Math.min(...vals));
  }
  const alerts = db.listAlerts(trackerId, fromIso, toIso);
  return {
    trackerId,
    checks: checks.length,
    failures: checks.filter((c) => !c.ok).length,
    ...(values.length
      ? { min: Math.min(...values), max: Math.max(...values), avg: values.reduce((a, b) => a + b, 0) / values.length }
      : {}),
    alerts: alerts.length,
    relevant: alerts.map((a) => ({ at: a.at, title: a.text.split('\n')[0], value: a.value, sourceUrl: a.sourceUrl })),
  };
}

export interface DigestDeps {
  db: Db;
  llm: LlmClient;
  notifier: Notifier;
  model: string;
  sendWhatsApp: boolean;
  now: () => Date;
}

const PERIOD_HOURS: Record<DigestPeriod, number> = { daily: 24, weekly: 24 * 7 };
const DIGEST_HOUR = 8;

export async function generateDigest(deps: DigestDeps, period: DigestPeriod): Promise<{ sent: boolean; text?: string }> {
  const { db, llm, notifier, model, sendWhatsApp, now } = deps;
  const to = now();
  const from = new Date(to.getTime() - PERIOD_HOURS[period] * 3600_000);
  const sections = db
    .listTrackers()
    .filter((t) => t.digest === period)
    .map((t) => ({ name: t.name, kind: t.kind, stats: computeStats(db, t.id, from.toISOString(), to.toISOString()) }))
    .filter((s) => s.stats.alerts > 0);

  db.setSetting(`digest_last_${period}`, to.toISOString());
  if (sections.length === 0) return { sent: false };

  const reply = await llm.chat({
    model,
    system:
      'Você escreve resumos curtos em português do Brasil para WhatsApp sobre acompanhamentos pessoais. ' +
      'Use SOMENTE os números e links fornecidos; não calcule nem invente valores. Seja objetivo, com um bloco por acompanhamento.',
    messages: [
      { role: 'user', content: `Resumo ${period === 'daily' ? 'diário' : 'semanal'}. Dados:\n${JSON.stringify(sections, null, 2)}` },
    ],
  });
  const text = reply.text.trim();
  db.addReport({ period, text, at: to.toISOString() });
  if (sendWhatsApp) await notifier.sendInfo(text);
  return { sent: true, text };
}

/** Quais resumos já venceram (a partir das 8h locais) e ainda não foram gerados no período. */
export function dueDigests(db: Db, now: Date): DigestPeriod[] {
  if (now.getHours() < DIGEST_HOUR) return [];
  const due: DigestPeriod[] = [];
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const lastDaily = db.getSetting('digest_last_daily');
  if (!lastDaily || Date.parse(lastDaily) < startOfToday) due.push('daily');
  const lastWeekly = db.getSetting('digest_last_weekly');
  if (!lastWeekly || now.getTime() - Date.parse(lastWeekly) >= 7 * 24 * 3600_000 - 3600_000) due.push('weekly');
  return due;
}
