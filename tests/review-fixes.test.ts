import { describe, it, expect } from 'vitest';
import { decideAlert, reliableValue, type DecisionContext } from '../src/service/decide';
import { openDb } from '../src/service/db';
import { joinTextBlocks, type LlmClient } from '../src/service/llm';
import { runSmartCheck, CheckError } from '../src/service/checker';
import { runCheck } from '../src/service/pipeline';
import { Notifier, nextBackoffMs, selfJid, reconnectDelayMs, type Transport } from '../src/service/notifier';
import { spentSince } from '../src/service/cost';
import { SetupSession } from '../src/service/setupChat';
import { computeStats, generateDigest } from '../src/service/reports';
import type { Finding, NewTracker, Tracker } from '../src/shared/types';

const nt = (over: Partial<NewTracker> = {}): NewTracker => ({
  name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'daily', ...over,
});
const tracker = (over: Partial<Tracker> = {}): Tracker => ({ ...nt(), id: 1, status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over });
const f = (value: number, confidence = 0.9, extra: Partial<Finding> = {}): Finding =>
  ({ found: true, value, currency: 'BRL', sourceUrl: 'https://loja/a', evidence: 'e', confidence, ...extra });
const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({ isNew: () => true, now: '2026-01-02T12:00:00Z', ...over });
const usage = { model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 50, searches: 1 };

describe('C1: achados de baixa confiança não viram linha de base', () => {
  it('reliableValue ignora baixa confiança e moeda diferente de BRL', () => {
    expect(reliableValue([f(95), f(10, 0.2), f(5, 0.9, { currency: 'USD' })])).toBe(95);
    expect(reliableValue([f(10, 0.2)])).toBeUndefined();
  });
  it('db.lastValue ignora achado de baixa confiança', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: '2026-01-01T00:00:00Z', ok: true, findings: [f(95), f(10, 0.2)], model: 'm', costUsd: 0 });
    expect(db.lastValue(t.id)).toBe(95);
  });
  it('computeStats não conta achado de baixa confiança em min/max/avg', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [f(95), f(10, 0.2)], model: 'm', costUsd: 0 });
    const s = computeStats(db, t.id, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(s).toMatchObject({ min: 95, max: 95, avg: 95 });
  });
});

describe('C2: below_value só alerta ao cruzar o limite', () => {
  const t = tracker({ alertCondition: { type: 'below_value', value: 3500 } });
  it('já estava abaixo do limite na verificação anterior: não repete', () => {
    expect(decideAlert(t, [f(2900)], ctx({ lastValue: 3000 })).alert).toBeUndefined();
  });
  it('estava acima e cruzou o limite: alerta', () => {
    expect(decideAlert(t, [f(3400)], ctx({ lastValue: 4000 })).alert).toBeDefined();
  });
  it('sem histórico e abaixo do limite: alerta (primeira vez)', () => {
    expect(decideAlert(t, [f(3400)], ctx()).alert).toBeDefined();
  });
});

describe('I1: oscilação não gera alerta a cada volta', () => {
  const base = { lastValue: 100, lastAlertAt: '2026-01-02T10:00:00Z', lastAlertValue: 90, lastAlertSourceUrl: 'https://outra' };
  it('mesmo valor (ou maior) que o último alertado, em outra loja, dentro de 24h: suprime', () => {
    expect(decideAlert(tracker(), [f(90)], ctx(base)).alert).toBeUndefined();
  });
  it('valor menor que o último alertado: alerta', () => {
    expect(decideAlert(tracker(), [f(85)], ctx(base)).alert).toBeDefined();
  });
  it('depois de 24h volta a alertar', () => {
    expect(decideAlert(tracker(), [f(90)], ctx({ ...base, lastAlertAt: '2026-01-01T10:00:00Z' })).alert).toBeDefined();
  });
});

describe('I9: moeda diferente não é comparada', () => {
  it('achado em USD é ignorado, sem alerta nem linha de base', () => {
    const d = decideAlert(tracker(), [f(499, 0.9, { currency: 'USD' })], ctx({ lastValue: 3999 }));
    expect(d.alert).toBeUndefined();
    expect(d.baseline).toBe(false);
    expect(d.ignored.some((s) => s.includes('USD'))).toBe(true);
  });
});

describe('I2: texto com citações é unido sem separador', () => {
  it('não injeta quebra de linha no meio de uma string JSON', () => {
    const blocks = [{ type: 'text', text: '{"a":"x' }, { type: 'server_tool_use' }, { type: 'text', text: 'y"}' }];
    expect(joinTextBlocks(blocks)).toBe('{"a":"xy"}');
  });
});

describe('I3: falhas carregam o custo já gasto', () => {
  const tr = tracker();
  const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
  const llmFrom = (texts: string[]): LlmClient => {
    let i = 0;
    return { async search(req) { return { text: texts[Math.min(i++, texts.length - 1)], usage: { ...usage, model: req.model } }; }, async chat() { throw new Error('x'); } };
  };
  const low = JSON.stringify({ findings: [{ found: true, value: 1, evidence: 'e', confidence: 0.2 }] });

  it('JSON inválido: CheckError traz o uso da chamada', async () => {
    const err = await runSmartCheck(llmFrom(['lixo']), tr, models).catch((e) => e);
    expect(err).toBeInstanceOf(CheckError);
    expect(err.usages).toHaveLength(1);
  });
  it('falha na escalada preserva o uso do modelo de rotina também', async () => {
    const err = await runSmartCheck(llmFrom([low, 'lixo']), tr, models).catch((e) => e);
    expect(err.usages.map((u: any) => u.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });
  it('o pipeline grava custo > 0 na verificação que falhou', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    const transport: Transport = { isReady: () => true, async sendToSelf() {} };
    const notifier = new Notifier(db, transport);
    const r = await runCheck({ db, llm: llmFrom(['lixo']), notifier, models, now: () => new Date() }, t.id);
    expect(r.ok).toBe(false);
    expect(db.listChecks(t.id)[0].costUsd).toBeGreaterThan(0);
  });
});

describe('I4: todo gasto entra no limite', () => {
  it('spentSince soma verificações e outros gastos (conversa, resumos)', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: '2026-01-10T10:00:00Z', ok: true, findings: [], model: 'm', costUsd: 1 });
    db.addSpend({ at: '2026-01-10T11:00:00Z', usd: 0.5, source: 'setup' });
    db.addSpend({ at: '2026-01-01T11:00:00Z', usd: 9, source: 'setup' });
    expect(spentSince(db, '2026-01-05T00:00:00Z')).toBeCloseTo(1.5, 6);
  });
  it('SetupSession informa o uso de cada resposta', async () => {
    const seen: number[] = [];
    const llm: LlmClient = {
      async search() { throw new Error('x'); },
      async chat() { return { text: 'oi', toolUses: [], content: [{ type: 'text', text: 'oi' }], usage }; },
    };
    await new SetupSession(llm, 'm', (u) => seen.push(u.inputTokens)).send('olá');
    expect(seen).toEqual([100]);
  });
  it('generateDigest informa o uso da IA', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addAlert({ trackerId: t.id, at: '2026-03-10T11:00:00Z', text: 'q', value: 1, delivered: true });
    const seen: number[] = [];
    const llm: LlmClient = {
      async search() { throw new Error('x'); },
      async chat() { return { text: 'R', toolUses: [], content: [], usage }; },
    };
    const notifier = new Notifier(db, { isReady: () => false, async sendToSelf() {} });
    await generateDigest({ db, llm, notifier, model: 'm', sendWhatsApp: false, now: () => new Date('2026-03-10T12:00:00Z'), onUsage: (u) => seen.push(u.outputTokens) }, 'daily');
    expect(seen).toEqual([50]);
  });
});

describe('I6: entregas serializadas e com timeout', () => {
  function slowSetup(delayMs: number) {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    const sent: string[] = [];
    const transport: Transport = {
      isReady: () => true,
      sendToSelf: (text) => new Promise((res) => setTimeout(() => { sent.push(text); res(); }, delayMs)),
    };
    return { db, t, sent, notifier: new Notifier(db, transport) };
  }
  it('send() concorrente com flushPending() não entrega o mesmo alerta duas vezes', async () => {
    const { notifier, t, sent } = slowSetup(40);
    const p1 = notifier.send(t.id, 'uma vez só');
    const p2 = notifier.flushPending();
    await Promise.all([p1, p2]);
    expect(sent).toEqual(['uma vez só']);
  });
  it('transporte travado não pendura o send: estoura o timeout e o alerta fica pendente', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    const transport: Transport = { isReady: () => true, sendToSelf: () => new Promise(() => {}) };
    const notifier = new Notifier(db, transport, () => new Date(), { sendTimeoutMs: 30 });
    await notifier.send(t.id, 'preso');
    expect(db.pendingAlerts()).toHaveLength(1);
  });
});

describe('I7: duas verificações simultâneas do mesmo acompanhamento', () => {
  it('a segunda é recusada e a IA é chamada uma única vez', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    let calls = 0;
    const llm: LlmClient = {
      async search(req) {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { text: JSON.stringify({ findings: [{ found: true, value: 100, currency: 'BRL', evidence: 'e', confidence: 0.9, source_url: 'u' }] }), usage: { ...usage, model: req.model } };
      },
      async chat() { throw new Error('x'); },
    };
    const notifier = new Notifier(db, { isReady: () => true, async sendToSelf() {} });
    const deps = { db, llm, notifier, models: { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' }, now: () => new Date() };
    const [a, b] = await Promise.all([runCheck(deps, t.id), runCheck(deps, t.id)]);
    expect(calls).toBe(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const refused = a.ok ? b : a;
    expect(refused.error).toMatch(/andamento/);
    // liberado ao terminar: uma nova verificação volta a funcionar
    expect((await runCheck(deps, t.id)).ok).toBe(true);
  });
});

describe('I5: reconexão do WhatsApp com espera crescente', () => {
  it('nextBackoffMs dobra a partir de 30s e tem teto de 10 min', () => {
    expect(nextBackoffMs(0)).toBe(30_000);
    expect(nextBackoffMs(1)).toBe(60_000);
    expect(nextBackoffMs(2)).toBe(120_000);
    expect(nextBackoffMs(10)).toBe(600_000);
  });
});

describe('I4: custo por acompanhamento nas estatísticas', () => {
  it('computeStats soma o custo das verificações do período', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt());
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [f(95)], model: 'm', costUsd: 0.03 });
    db.addCheck({ trackerId: t.id, at: '2026-01-01T11:00:00Z', ok: false, error: 'x', findings: [], model: 'm', costUsd: 0.02 });
    expect(computeStats(db, t.id, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z').costUsd).toBeCloseTo(0.05, 6);
  });
});

describe('transporte Baileys: helpers puros', () => {
  it('selfJid tira o sufixo de dispositivo e monta o JID do próprio número', () => {
    expect(selfJid('5511999990000:12@s.whatsapp.net')).toBe('5511999990000@s.whatsapp.net');
    expect(selfJid('5511999990000@s.whatsapp.net')).toBe('5511999990000@s.whatsapp.net');
  });
  it('selfJid recusa id vazio ou sem número', () => {
    expect(() => selfJid('')).toThrow();
    expect(() => selfJid(undefined)).toThrow();
  });
  it('reconectar: 1ª queda reconecta logo (2s, como o 515 pós-QR); depois espera crescente com teto', () => {
    expect(reconnectDelayMs(0)).toBe(2_000);
    expect(reconnectDelayMs(1)).toBe(30_000);
    expect(reconnectDelayMs(2)).toBe(60_000);
    expect(reconnectDelayMs(20)).toBe(600_000);
  });
});
