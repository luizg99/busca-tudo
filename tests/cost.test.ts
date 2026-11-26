import { describe, it, expect } from 'vitest';
import { estimateCostUsd, spentSince, overLimit } from '../src/service/cost';
import { openDb } from '../src/service/db';

const mkDb = () => {
  const db = openDb(':memory:');
  const t = db.createTracker({
    name: 'x', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
    alertCondition: { type: 'below_last' }, digest: 'none',
  });
  const add = (at: Date, costUsd: number) =>
    db.addCheck({ trackerId: t.id, at: at.toISOString(), ok: true, findings: [], model: 'm', costUsd });
  return { db, add };
};

describe('estimateCostUsd', () => {
  it('haiku 5.5: tokens + buscas', () => {
    const c = estimateCostUsd({ model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000, searches: 3 });
    expect(c).toBeCloseTo(0.10 + 0.50 + 0.03, 6);
  });
  it('sonnet 5.5', () => {
    const c = estimateCostUsd({ model: 'claude-sonnet-5-5', inputTokens: 500_000, outputTokens: 100_000, searches: 0 });
    expect(c).toBeCloseTo(1.0 + 1.0, 6);
  });
  it('modelo desconhecido usa a tabela mais cara (conservador)', () => {
    const c = estimateCostUsd({ model: 'whatever', inputTokens: 1_000_000, outputTokens: 0, searches: 0 });
    expect(c).toBeCloseTo(2.0, 6);
  });
});

describe('overLimit', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);
  it('sem limites configurados nunca estoura', () => {
    const { db, add } = mkDb();
    add(new Date(2026, 0, 15, 8), 999);
    expect(overLimit(db, now)).toEqual({ over: false });
  });
  it('estoura o limite do dia', () => {
    const { db, add } = mkDb();
    db.setSetting('limit_day_usd', '0.5');
    add(new Date(2026, 0, 15, 8), 0.6);
    expect(overLimit(db, now)).toEqual({ over: true, period: 'day' });
  });
  it('gasto de ontem não conta para o dia mas conta para o mês', () => {
    const { db, add } = mkDb();
    db.setSetting('limit_day_usd', '0.5');
    add(new Date(2026, 0, 14, 12), 0.6);
    expect(overLimit(db, now).over).toBe(false);
    db.setSetting('limit_month_usd', '0.5');
    expect(overLimit(db, now)).toEqual({ over: true, period: 'month' });
  });
  it('spentSince soma só a partir da data', () => {
    const { db, add } = mkDb();
    add(new Date(2026, 0, 10), 1); add(new Date(2026, 0, 15, 9), 2);
    expect(spentSince(db, new Date(2026, 0, 12).toISOString())).toBeCloseTo(2, 6);
  });
});
