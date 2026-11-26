import type { Db } from './db';

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
}

/** USD por 1M de tokens (preços da Anthropic em 2026-11; conferir ao trocar de modelo). */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
const FALLBACK_PRICE = { in: 2, out: 10 };
const USD_PER_SEARCH = 0.01;

export function estimateCostUsd(u: Usage): number {
  const p = PRICES[u.model] ?? FALLBACK_PRICE;
  return (u.inputTokens * p.in + u.outputTokens * p.out) / 1_000_000 + u.searches * USD_PER_SEARCH;
}

export function spentSince(db: Db, sinceIso: string): number {
  const r = db.raw.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM checks WHERE at >= ?').get(sinceIso) as { s: number };
  return r.s;
}

export function overLimit(db: Db, now: Date): { over: boolean; period?: 'day' | 'month' } {
  const day = Number(db.getSetting('limit_day_usd'));
  const month = Number(db.getSetting('limit_month_usd'));
  if (day > 0) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (spentSince(db, start.toISOString()) >= day) return { over: true, period: 'day' };
  }
  if (month > 0) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    if (spentSince(db, start.toISOString()) >= month) return { over: true, period: 'month' };
  }
  return { over: false };
}
