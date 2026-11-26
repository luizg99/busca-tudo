import { describe, it, expect } from 'vitest';
import { computeStats, generateDigest, dueDigests } from '../src/service/reports';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker } from '../src/shared/types';

const nt = (over: Partial<NewTracker> = {}): NewTracker => ({
  name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'daily', ...over,
});
const f = (value: number): Finding => ({ found: true, value, evidence: 'e', confidence: 0.9 });
const NOW = new Date('2026-03-10T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

function setup() {
  const db = openDb(':memory:');
  const t = db.createTracker(nt());
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  const notifier = new Notifier(db, transport, () => NOW);
  const chatCalls: Array<{ system: string; messages: any[] }> = [];
  const llm: LlmClient = {
    async search() { throw new Error('x'); },
    async chat(req) {
      chatCalls.push({ system: req.system, messages: req.messages });
      return { text: 'RESUMO DO DIA', toolUses: [], content: [], usage: { model: req.model, inputTokens: 10, outputTokens: 10, searches: 0 } };
    },
  };
  const check = (at: string, findings: Finding[], ok = true) =>
    db.addCheck({ trackerId: t.id, at, ok, error: ok ? undefined : 'falhou', findings, model: 'm', costUsd: 0 });
  return { db, t, sent, notifier, llm, chatCalls, check };
}

describe('computeStats', () => {
  it('calcula min/max/avg só das verificações ok e conta falhas e alertas', () => {
    const { db, t, check } = setup();
    check(iso(10), [f(100)]); check(iso(5), [f(90)]); check(iso(3), [], false); check(iso(100), [f(1)]);
    db.addAlert({ trackerId: t.id, at: iso(5), text: '📉 PS5: R$ 90,00', sourceUrl: 'u', value: 90, delivered: true });
    const s = computeStats(db, t.id, iso(24), NOW.toISOString());
    expect(s).toMatchObject({ trackerId: t.id, checks: 3, failures: 1, min: 90, max: 100, avg: 95, alerts: 1 });
    expect(s.relevant).toEqual([{ at: iso(5), title: '📉 PS5: R$ 90,00', value: 90, sourceUrl: 'u' }]);
  });
  it('período sem verificações ok não inventa números', () => {
    const { db, t } = setup();
    const s = computeStats(db, t.id, iso(24), NOW.toISOString());
    expect(s.checks).toBe(0);
    expect(s.min).toBeUndefined();
    expect(s.avg).toBeUndefined();
  });
});

describe('generateDigest', () => {
  const base = (s: ReturnType<typeof setup>, sendWhatsApp: boolean) =>
    ({ db: s.db, llm: s.llm, notifier: s.notifier, model: 'claude-haiku-5-5', sendWhatsApp, now: () => NOW });

  it('sem nada relevante: não chama IA, não grava, não manda mensagem', async () => {
    const s = setup();
    s.check(iso(2), [f(100)]);
    const r = await generateDigest(base(s, true), 'daily');
    expect(r.sent).toBe(false);
    expect(s.chatCalls).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect(s.db.listReports()).toHaveLength(0);
  });

  it('com relevantes: IA escreve o texto a partir dos números, grava o relatório e envia se ligado', async () => {
    const s = setup();
    s.check(iso(5), [f(90)]);
    s.db.addAlert({ trackerId: s.t.id, at: iso(5), text: 'queda', sourceUrl: 'u', value: 90, delivered: true });
    const r = await generateDigest(base(s, true), 'daily');
    expect(r).toEqual({ sent: true, text: 'RESUMO DO DIA' });
    expect(JSON.stringify(s.chatCalls[0].messages)).toContain('PS5');
    expect(JSON.stringify(s.chatCalls[0].messages)).toContain('90');
    expect(s.db.listReports().map((x) => x.text)).toEqual(['RESUMO DO DIA']);
    expect(s.sent).toEqual(['RESUMO DO DIA']);
  });

  it('com WhatsApp desligado grava o relatório mas não envia', async () => {
    const s = setup();
    s.check(iso(5), [f(90)]);
    s.db.addAlert({ trackerId: s.t.id, at: iso(5), text: 'queda', value: 90, delivered: true });
    await generateDigest(base(s, false), 'daily');
    expect(s.db.listReports()).toHaveLength(1);
    expect(s.sent).toHaveLength(0);
  });

  it('só considera acompanhamentos com o mesmo período de resumo', async () => {
    const s = setup();
    const w = s.db.createTracker(nt({ digest: 'weekly', name: 'Semanal' }));
    s.db.addAlert({ trackerId: w.id, at: iso(5), text: 'q', value: 1, delivered: true });
    const r = await generateDigest(base(s, true), 'daily');
    expect(r.sent).toBe(false);
  });
});

describe('dueDigests', () => {
  it('não repete o resumo já gerado hoje', async () => {
    const s = setup();
    const at = new Date(2026, 2, 10, 9, 0, 0);
    expect(dueDigests(s.db, at)).toContain('daily');
    await generateDigest({ db: s.db, llm: s.llm, notifier: s.notifier, model: 'm', sendWhatsApp: false, now: () => at }, 'daily');
    expect(dueDigests(s.db, new Date(2026, 2, 10, 15, 0, 0))).not.toContain('daily');
    expect(dueDigests(s.db, new Date(2026, 2, 11, 9, 0, 0))).toContain('daily');
  });
  it('antes das 8h não vence', () => {
    const s = setup();
    expect(dueDigests(s.db, new Date(2026, 2, 10, 7, 0, 0))).toEqual([]);
  });
});
