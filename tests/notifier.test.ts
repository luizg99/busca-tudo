import { describe, it, expect } from 'vitest';
import { Notifier, type Transport } from '../src/service/notifier';
import { openDb } from '../src/service/db';

function setup() {
  const db = openDb(':memory:');
  const t = db.createTracker({
    name: 'x', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
    alertCondition: { type: 'below_last' }, digest: 'none',
  });
  const sent: string[] = [];
  const state = { ready: true, failOn: new Set<string>() };
  const transport: Transport = {
    isReady: () => state.ready,
    async sendToSelf(text) {
      if (state.failOn.has(text)) throw new Error('falhou');
      sent.push(text);
    },
  };
  return { db, t, sent, state, notifier: new Notifier(db, transport) };
}

describe('Notifier', () => {
  it('pronto: entrega e grava delivered=true', async () => {
    const { notifier, db, t, sent } = setup();
    await notifier.send(t.id, 'oi', { value: 10, sourceUrl: 'u' });
    expect(sent).toEqual(['oi']);
    expect(db.pendingAlerts()).toHaveLength(0);
    expect(db.lastAlertAt(t.id)).toBeDefined();
  });

  it('não pronto: grava pendente e não lança', async () => {
    const { notifier, db, t, sent, state } = setup();
    state.ready = false;
    await expect(notifier.send(t.id, 'oi')).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(db.pendingAlerts().map((a) => a.text)).toEqual(['oi']);
  });

  it('erro no envio deixa pendente e não lança', async () => {
    const { notifier, db, t, state } = setup();
    state.failOn.add('oi');
    await notifier.send(t.id, 'oi');
    expect(db.pendingAlerts()).toHaveLength(1);
  });

  it('flushPending entrega ao ficar pronto, conta e não reenvia', async () => {
    const { notifier, db, t, sent, state } = setup();
    state.ready = false;
    await notifier.send(t.id, 'a');
    await notifier.send(t.id, 'b');
    state.ready = true;
    expect(await notifier.flushPending()).toBe(2);
    expect(sent).toEqual(['a', 'b']);
    expect(await notifier.flushPending()).toBe(0);
    expect(db.pendingAlerts()).toHaveLength(0);
  });

  it('flushPending sem conexão não entrega nada', async () => {
    const { notifier, t, state } = setup();
    state.ready = false;
    await notifier.send(t.id, 'a');
    expect(await notifier.flushPending()).toBe(0);
  });

  it('erro em um pendente não impede os demais', async () => {
    const { notifier, db, t, sent, state } = setup();
    state.ready = false;
    await notifier.send(t.id, 'a');
    await notifier.send(t.id, 'b');
    state.ready = true;
    state.failOn.add('a');
    expect(await notifier.flushPending()).toBe(1);
    expect(sent).toEqual(['b']);
    expect(db.pendingAlerts().map((x) => x.text)).toEqual(['a']);
  });
});

describe('Notifier.sendInfo', () => {
  it('envia texto avulso sem gravar alerta e informa se entregou', async () => {
    const { notifier, db, sent, state } = setup();
    expect(await notifier.sendInfo('resumo')).toBe(true);
    expect(sent).toEqual(['resumo']);
    expect(db.pendingAlerts()).toHaveLength(0);
    state.ready = false;
    expect(await notifier.sendInfo('outro')).toBe(false);
  });
});
