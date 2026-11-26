import { describe, it, expect } from 'vitest';
import { runSmartCheck } from '../src/service/checker';
import { decideAlert, paymentLabel } from '../src/service/decide';
import { computeStats } from '../src/service/reports';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker, Tracker } from '../src/shared/types';

const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: false } as Tracker;
const f = (over: Partial<Finding> = {}): Finding => ({ found: true, value: 3400, currency: 'BRL', title: 'x', sourceUrl: 'https://www.amazon.com.br/dp/x', evidence: 'e', confidence: 0.9, ...over });

describe('pagamento: à vista ou só parcelado', () => {
  it('paymentLabel descreve sem inventar: desconhecido fica sem texto', () => {
    expect(paymentLabel({ payment: 'vista', paymentNote: 'Pix' })).toBe('à vista (Pix)');
    expect(paymentLabel({ payment: 'parcelado', paymentNote: '10x sem juros' })).toBe('só parcelado (10x sem juros)');
    expect(paymentLabel({ payment: 'vista' })).toBe('à vista');
    expect(paymentLabel({})).toBeUndefined();
  });

  it('a busca pede payment e o normalizador só aceita vista/parcelado', async () => {
    const prompts: string[] = [];
    const llm: LlmClient = {
      async search(req) {
        prompts.push(req.system);
        return { text: JSON.stringify({ findings: [
          { found: true, value: 3400, currency: 'BRL', source_url: 'https://a.com/x', payment: 'vista', payment_note: 'Pix', evidence: 'e', confidence: 0.9 },
          { found: true, value: 3600, currency: 'BRL', source_url: 'https://b.com/x', payment: 'qualquer coisa', evidence: 'e', confidence: 0.9 },
        ] }), usage };
      },
      async chat() { throw new Error('x'); },
    };
    const out = await runSmartCheck(llm, tracker, { routine: 'r', escalate: 'e' });
    expect(prompts[0]).toMatch(/"payment"/);
    expect(prompts[0]).toMatch(/TOTAL/);
    expect(out.findings[0]).toMatchObject({ payment: 'vista', paymentNote: 'Pix' });
    expect(out.findings[1].payment).toBeUndefined();
  });

  it('o alerta informa como o menor preço é pago', () => {
    const d = decideAlert(tracker, [f({ payment: 'parcelado', paymentNote: '10x sem juros' })], { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' });
    expect(d.alert!.text).toContain('Pagamento: só parcelado (10x sem juros)');
  });

  it('a estatística guarda o pagamento do menor preço', () => {
    const db = openDb(':memory:');
    const t = db.createTracker({ name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' });
    db.addCheck({ trackerId: t.id, at: '2026-01-10T10:00:00.000Z', ok: true, findings: [f({ value: 3900 })], model: 'm', costUsd: 0 });
    db.addCheck({ trackerId: t.id, at: '2026-01-10T11:00:00.000Z', ok: true, findings: [f({ value: 3500, payment: 'vista', paymentNote: 'Pix' })], model: 'm', costUsd: 0 });
    const s = computeStats(db, t.id, '2026-01-09T00:00:00.000Z', '2026-01-11T00:00:00.000Z');
    expect(s).toMatchObject({ min: 3500, minPayment: 'vista', minPaymentNote: 'Pix' });
  });

  it('a rotina por código mantém o pagamento aprendido na descoberta', async () => {
    const REGEX = 'R\\$\\s*([\\d.,]+)';
    const URL1 = 'https://www.amazon.com.br/dp/PS5';
    const base: NewTracker = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', onlyTrusted: false };
    const db = openDb(':memory:');
    const t = db.createTracker(base);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    let clock = new Date('2026-01-10T10:00:00Z').getTime();
    const now = () => new Date(clock);
    let price = '3524,00';
    const fetchPage = async (): Promise<FetchResult> => ({ ok: true, html: `<html><body>Console PS5 Por R$ ${price}</body></html>` });
    const llm: LlmClient = {
      async search(req) {
        return { text: JSON.stringify({ findings: [{ found: true, value: 3524, currency: 'BRL', title: 'Amazon', source_url: URL1, payment: 'vista', payment_note: 'Pix', evidence: 'e', confidence: 0.9, price_regex: REGEX }] }), usage: { ...usage, model: req.model } };
      },
      async chat() { throw new Error('x'); },
    };
    const deps = { db, llm, notifier: new Notifier(db, transport, now), models: { routine: 'r', escalate: 'e' }, now, fetchPage };
    await runCheck(deps, t.id);
    clock += 65 * 60000;
    price = '3400,00';
    const r = await runCheck(deps, t.id);
    expect(r.alerted).toBe(true);
    expect(db.listChecks(t.id)[0].mode).toBe('routine');
    expect(db.listChecks(t.id)[0].findings[0]).toMatchObject({ payment: 'vista', paymentNote: 'Pix' });
    expect(sent.at(-1)).toContain('Pagamento: à vista (Pix)');
  });
});
