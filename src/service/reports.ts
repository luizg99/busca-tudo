import type { Usage } from './cost';
import type { Db } from './db';
import { reliableValue } from './decide';
import type { LlmClient } from './llm';
import type { Notifier } from './notifier';

/** Um site em que o preço não pôde ser lido nem pelo código (plano A) nem pela IA (plano B). */
export interface SourceProblem {
  url: string;
  label?: string;
  status: 'failing' | 'unreadable';
  error?: string;
  failures: number;
  since?: string;
}

export interface TrackerStats {
  trackerId: number;
  checks: number;
  failures: number;
  min?: number;
  max?: number;
  avg?: number;
  alerts: number;
  costUsd: number;
  sourceProblems: SourceProblem[];
  sourcesOk: number;
  relevant: Array<{ at: string; title?: string; value?: number; sourceUrl?: string }>;
}

export type DigestPeriod = 'daily' | 'weekly';

export function computeStats(db: Db, trackerId: number, fromIso: string, toIso: string): TrackerStats {
  const checks = db.listChecksBetween(trackerId, fromIso, toIso);
  const values: number[] = [];
  for (const c of checks) {
    if (!c.ok) continue;
    const v = reliableValue(c.findings);
    if (v !== undefined) values.push(v);
  }
  const alerts = db.listAlerts(trackerId, fromIso, toIso);
  const sources = db.listSources(trackerId);
  return {
    trackerId,
    sourceProblems: sources
      .filter((s) => s.status === 'unreadable' || s.status === 'failing')
      .map((s) => ({ url: s.url, label: s.label, status: s.status as 'failing' | 'unreadable', error: s.lastError, failures: s.consecutiveFailures, since: s.failingSince })),
    sourcesOk: sources.filter((s) => s.status === 'ok').length,
    checks: checks.length,
    failures: checks.filter((c) => !c.ok).length,
    ...(values.length
      ? { min: Math.min(...values), max: Math.max(...values), avg: values.reduce((a, b) => a + b, 0) / values.length }
      : {}),
    alerts: alerts.length,
    costUsd: checks.reduce((sum, c) => sum + c.costUsd, 0),
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
  onUsage?: (u: Usage) => void;
}

const PERIOD_HOURS: Record<DigestPeriod, number> = { daily: 24, weekly: 24 * 7 };
const DIGEST_HOUR = 8;

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

/** Seção fixa (sem IA) do relatório: sites em que o preço não foi lido nem pelo plano A nem pelo B, com o motivo. */
export function renderSourceProblems(items: Array<{ tracker: string; problems: SourceProblem[] }>): string {
  const lines: string[] = [];
  for (const { tracker, problems } of items) {
    for (const p of problems) {
      const site = p.label || hostOf(p.url);
      const detail =
        p.status === 'unreadable'
          ? 'só aparece na busca completa (o preço não está no HTML da página)'
          : `${p.failures} verificações seguidas sem preço${p.since ? ` (desde ${new Date(p.since).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})` : ''}`;
      lines.push(`• ${tracker} — ${site}: ${p.error ?? 'motivo desconhecido'} · ${detail}`);
    }
  }
  if (lines.length === 0) return '';
  return ['⚠️ Sites sem preço', 'O preço não pôde ser lido pelo código (plano A) nem pela IA (plano B) nestes sites:', ...lines].join('\n');
}

export async function generateDigest(deps: DigestDeps, period: DigestPeriod): Promise<{ sent: boolean; text?: string }> {
  const { db, llm, notifier, model, sendWhatsApp, now } = deps;
  const to = now();
  const from = new Date(to.getTime() - PERIOD_HOURS[period] * 3600_000);
  const all = db
    .listTrackers()
    .filter((t) => t.digest === period)
    .map((t) => ({ name: t.name, kind: t.kind, stats: computeStats(db, t.id, from.toISOString(), to.toISOString()) }));
  // A IA só resume as quedas de preço; os sites sem preço entram como texto fixo (sem IA) para ficarem sempre claros.
  const sections = all
    .filter((s) => s.stats.alerts > 0)
    .map(({ name, kind, stats }) => {
      const { sourceProblems: _problems, sourcesOk: _ok, ...forAi } = stats;
      return { name, kind, stats: forAi };
    });
  const problems = all.filter((s) => s.stats.sourceProblems.length > 0).map((s) => ({ tracker: s.name, problems: s.stats.sourceProblems }));

  db.setSetting(`digest_last_${period}`, to.toISOString());
  if (sections.length === 0 && problems.length === 0) return { sent: false };

  let body = 'Nenhum alerta de preço neste período.';
  if (sections.length > 0) {
    const reply = await llm.chat({
    model,
    system:
      'Você escreve resumos curtos em português do Brasil para WhatsApp sobre acompanhamentos pessoais. ' +
      'Use SOMENTE os números e links fornecidos; não calcule nem invente valores. Seja objetivo, com um bloco por acompanhamento.',
    messages: [
      { role: 'user', content: `Resumo ${period === 'daily' ? 'diário' : 'semanal'}. Dados:\n${JSON.stringify(sections, null, 2)}` },
    ],
  });
    deps.onUsage?.(reply.usage);
    body = reply.text.trim();
  }
  const problemBlock = renderSourceProblems(problems);
  const text = problemBlock ? `${body}\n\n${problemBlock}` : body;
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
