import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { NewTracker } from '../src/shared/types';

const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
const priceTracker: NewTracker = {
  name: 'PS5', kind: 'price', goal: 'menor preço', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'none',
};
const newsTracker: NewTracker = { ...priceTracker, name: 'Notícias', kind: 'news', alertCondition: { type: 'new_items' } };

const priceJson = (v: number, url = 'https://loja/a') =>
  JSON.stringify({ findings: [{ found: true, value: v, currency: 'BRL', source_url: url, evidence: 'e', confidence: 0.9 }] });
const newsJson = (url: string) =>
  JSON.stringify({ findings: [{ found: true, title: 'Título ' + url, source_url: url, evidence: 'e', confidence: 0.9 }] });

function setup(tracker: NewTracker) {
  const db = openDb(':memory:');
  const t = db.createTracker(tracker);
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  let clock = new Date('2026-01-01T10:00:00Z').getTime();
  const now = () => new Date(clock);
  const advance = (min: number) => { clock += min * 60000; };
  const script: Array<string | Error> = [];
  let calls = 0;
  const llm: LlmClient = {
    async search(req) {
      calls++;
      const next = script.shift();
      if (next === undefined) throw new Error('sem resposta no script');
      if (next instanceof Error) throw next;
      return { text: next, usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 1 } };
    },
    async chat() { throw new Error('x'); },
  };
  const notifier = new Notifier(db, transport, now);
  const deps = { db, llm, notifier, models, now };
  return { db, t, sent, script, advance, deps, calls: () => calls };
}

describe('runCheck', () => {
  it('1ª verificação de preço grava linha de base sem alerta', async () => {
    const { deps, t, script, db, sent } = setup(priceTracker);
    script.push(priceJson(100));
    const r = await runCheck(deps, t.id);
    expect(r).toMatchObject({ ok: true, alerted: false, baseline: true });
    expect(sent).toHaveLength(0);
    expect(db.listChecks(t.id)).toHaveLength(1);
    expect(db.listChecks(t.id)[0].costUsd).toBeGreaterThan(0);
  });

  it('oscilação 100→90→100→90: alerta uma vez; a volta ao mesmo 90 é ruído; só um novo mínimo alerta', async () => {
    const { deps, t, script, advance, sent } = setup(priceTracker);
    script.push(priceJson(100), priceJson(90), priceJson(100), priceJson(90), priceJson(100), priceJson(85));
    await runCheck(deps, t.id); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(true); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(false); advance(120);
    expect((await runCheck(deps, t.id)).alerted).toBe(false); advance(60); // volta a 90: já alertado nas últimas 24h
    await runCheck(deps, t.id); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(true); // 85 < 90: novo mínimo
    expect(sent).toHaveLength(2);
  });

  it('mesmo valor de novo não alerta', async () => {
    const { deps, t, script, advance } = setup(priceTracker);
    script.push(priceJson(100), priceJson(100));
    await runCheck(deps, t.id); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(false);
  });

  it('CheckError grava falha, não alerta, não lança e preserva lastValue', async () => {
    const { deps, t, script, db, advance } = setup(priceTracker);
    script.push(priceJson(100), 'lixo sem json');
    await runCheck(deps, t.id); advance(60);
    const r = await runCheck(deps, t.id);
    expect(r).toMatchObject({ ok: false, alerted: false });
    expect(r.error).toBeTruthy();
    expect(db.listChecks(t.id)[0]).toMatchObject({ ok: false });
    expect(db.lastValue(t.id)).toBe(100);
  });

  it('falha de rede da IA também é gravada sem lançar', async () => {
    const { deps, t, script, db } = setup(priceTracker);
    script.push(new Error('ECONNRESET'));
    expect((await runCheck(deps, t.id)).ok).toBe(false);
    expect(db.listChecks(t.id)).toHaveLength(1);
  });

  it('notícia: o mesmo link alerta só na primeira vez', async () => {
    const { deps, t, script, advance, sent } = setup(newsTracker);
    script.push(newsJson('u1'), newsJson('u1'), newsJson('u2'));
    expect((await runCheck(deps, t.id)).alerted).toBe(true); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(false); advance(60);
    expect((await runCheck(deps, t.id)).alerted).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('acompanhamento pausado ou inexistente não chama a IA', async () => {
    const { deps, t, db, calls } = setup(priceTracker);
    db.updateTracker(t.id, { status: 'paused' });
    expect((await runCheck(deps, t.id)).ok).toBe(false);
    expect((await runCheck(deps, 9999)).ok).toBe(false);
    expect(calls()).toBe(0);
  });
});
