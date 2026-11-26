import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/service/scheduler';
import { openDb } from '../src/service/db';
import type { NewTracker } from '../src/shared/types';

const nt = (over: Partial<NewTracker> = {}): NewTracker => ({
  name: 'x', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15,
  alertCondition: { type: 'below_last' }, digest: 'none', ...over,
});

function setup() {
  const db = openDb(':memory:');
  let clock = new Date('2026-01-10T12:00:00Z').getTime();
  const ran: number[] = [];
  const run = async (id: number) => { ran.push(id); };
  const sched = new Scheduler({ db, run, now: () => new Date(clock) });
  const checked = (id: number, atMsAgo: number) =>
    db.addCheck({ trackerId: id, at: new Date(clock - atMsAgo).toISOString(), ok: true, findings: [], model: 'm', costUsd: 0 });
  return { db, ran, sched, checked, setClock: (ms: number) => { clock = ms; }, getClock: () => clock, run };
}
const MIN = 60000;

describe('Scheduler.tick', () => {
  it('roda quem nunca foi checado', async () => {
    const { db, ran, sched } = setup();
    const t = db.createTracker(nt());
    await sched.tick();
    expect(ran).toEqual([t.id]);
  });
  it('não roda quem foi checado há menos que o intervalo', async () => {
    const { db, ran, sched, checked } = setup();
    const t = db.createTracker(nt({ intervalMinutes: 60 }));
    checked(t.id, 30 * MIN);
    await sched.tick();
    expect(ran).toEqual([]);
  });
  it('roda quando o intervalo já passou', async () => {
    const { db, ran, sched, checked } = setup();
    const t = db.createTracker(nt({ intervalMinutes: 60 }));
    checked(t.id, 61 * MIN);
    await sched.tick();
    expect(ran).toEqual([t.id]);
  });
  it('não roda pausados', async () => {
    const { db, ran, sched } = setup();
    const t = db.createTracker(nt());
    db.updateTracker(t.id, { status: 'paused' });
    await sched.tick();
    expect(ran).toEqual([]);
  });
  it('PC acordando 3 dias depois roda UMA vez por acompanhamento', async () => {
    const { db, ran, sched, checked } = setup();
    const a = db.createTracker(nt()); const b = db.createTracker(nt());
    checked(a.id, 3 * 24 * 60 * MIN); checked(b.id, 3 * 24 * 60 * MIN);
    await sched.tick();
    expect(ran).toEqual([a.id, b.id]);
  });
  it('limite de custo estourado: não roda nada', async () => {
    const { db, ran, sched } = setup();
    const t = db.createTracker(nt());
    db.setSetting('limit_day_usd', '0.5');
    db.addCheck({ trackerId: t.id, at: new Date('2026-01-10T08:00:00Z').toISOString(), ok: true, findings: [], model: 'm', costUsd: 0.6 });
    // 08:00Z fica no mesmo dia local em fusos de -12h a +11h
    await sched.tick();
    expect(ran).toEqual([]);
  });
  it('erro em um acompanhamento não impede o próximo', async () => {
    const { db, sched } = setup();
    const a = db.createTracker(nt()); const b = db.createTracker(nt());
    const ran: number[] = [];
    const s = new Scheduler({ db, now: () => new Date('2026-01-10T12:00:00Z'), run: async (id) => { ran.push(id); if (id === a.id) throw new Error('boom'); } });
    await s.tick();
    expect(ran).toEqual([a.id, b.id]);
  });
  it('tick reentrante enquanto outro roda não duplica', async () => {
    const { db } = setup();
    const t = db.createTracker(nt());
    let count = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new Scheduler({ db, now: () => new Date('2026-01-10T12:00:00Z'), run: async () => { count++; await gate; } });
    const p1 = s.tick();
    const p2 = s.tick();
    release();
    await Promise.all([p1, p2]);
    expect(count).toBe(1);
    expect(t.id).toBeGreaterThan(0);
  });
});
