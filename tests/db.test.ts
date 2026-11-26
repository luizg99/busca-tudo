import { describe, it, expect } from 'vitest';
import { openDb } from '../src/service/db';
import type { NewTracker, Finding } from '../src/shared/types';

const nt = (over: Partial<NewTracker> = {}): NewTracker => ({
  name: 'PS5', kind: 'price', goal: 'menor preço', include: ['novo', 'lacrado'], exclude: ['usado'],
  intervalMinutes: 60, alertCondition: { type: 'below_value', value: 3000 }, digest: 'daily', ...over,
});
const f = (value: number, confidence = 0.9): Finding => ({ found: true, value, evidence: 'x', confidence });

describe('db', () => {
  it('createTracker persiste arrays e alertCondition (roundtrip)', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    const got = db.getTracker(t.id)!;
    expect(got.include).toEqual(['novo', 'lacrado']);
    expect(got.exclude).toEqual(['usado']);
    expect(got.alertCondition).toEqual({ type: 'below_value', value: 3000 });
    expect(got.status).toBe('active');
    expect(db.listTrackers()).toHaveLength(1);
  });

  it('updateTracker altera status', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    expect(db.updateTracker(t.id, { status: 'paused' }).status).toBe('paused');
  });

  it('markSeen retorna true e depois false para a mesma chave', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    expect(db.markSeen(t.id, 'k')).toBe(true);
    expect(db.markSeen(t.id, 'k')).toBe(false);
  });

  it('lastValue ignora verificações com ok:false e usa o melhor valor da última ok', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: '2026-01-01T00:00:00Z', ok: true, findings: [f(120), f(100)], model: 'm', costUsd: 0 });
    db.addCheck({ trackerId: t.id, at: '2026-01-02T00:00:00Z', ok: false, error: 'boom', findings: [], model: 'm', costUsd: 0 });
    expect(db.lastValue(t.id)).toBe(100);
    expect(db.lastCheckAt(t.id)).toBe('2026-01-02T00:00:00Z');
  });

  it('pendingAlerts retorna só não entregues e some após markDelivered', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    const a = db.addAlert({ trackerId: t.id, at: '2026-01-01T00:00:00Z', text: 'oi', delivered: false });
    db.addAlert({ trackerId: t.id, at: '2026-01-01T00:00:00Z', text: 'ok', delivered: true });
    expect(db.pendingAlerts().map((x) => x.id)).toEqual([a]);
    db.markDelivered(a);
    expect(db.pendingAlerts()).toHaveLength(0);
    expect(db.lastAlertAt(t.id)).toBe('2026-01-01T00:00:00Z');
  });

  it('deleteTracker apaga checks e alertas em cascata', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: 'a', ok: true, findings: [f(1)], model: 'm', costUsd: 0 });
    db.addAlert({ trackerId: t.id, at: 'a', text: 't', delivered: false });
    db.markSeen(t.id, 'k');
    db.deleteTracker(t.id);
    expect(db.listChecks(t.id)).toHaveLength(0);
    expect(db.pendingAlerts()).toHaveLength(0);
  });

  it('settings e reports', () => {
    const db = openDb(':memory:');
    expect(db.getSetting('x')).toBeUndefined();
    db.setSetting('x', '1'); db.setSetting('x', '2');
    expect(db.getSetting('x')).toBe('2');
    db.addReport({ period: 'daily', text: 'r1', at: '2026-01-01T00:00:00Z' });
    db.addReport({ period: 'daily', text: 'r2', at: '2026-01-03T00:00:00Z' });
    expect(db.listReports({ since: '2026-01-02T00:00:00Z' }).map((r) => r.text)).toEqual(['r2']);
  });
});
