import { describe, it, expect } from 'vitest';
import { computeStats, generateDigest, renderSourceProblems } from '../src/service/reports';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { LlmClient } from '../src/service/llm';
import type { NewTracker } from '../src/shared/types';

const NOW = new Date('2026-03-10T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const nt = (over: Partial<NewTracker> = {}): NewTracker => ({
  name: 'PS5 Slim Digital', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'daily', ...over,
});

function setup() {
  const db = openDb(':memory:');
  const t = db.createTracker(nt());
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  const notifier = new Notifier(db, transport, () => NOW);
  const chat: string[] = [];
  const llm: LlmClient = {
    async search() { throw new Error('x'); },
    async chat(req) {
      chat.push(JSON.stringify(req.messages));
      return { text: 'RESUMO DAS QUEDAS', toolUses: [], content: [], usage: { model: req.model, inputTokens: 10, outputTokens: 10, searches: 0 } };
    },
  };
  const deps = (sendWhatsApp = true) => ({ db, llm, notifier, model: 'claude-haiku-5-5', sendWhatsApp, now: () => NOW });
  return { db, t, sent, chat, deps };
}

describe('computeStats: sites sem preço', () => {
  it('lista fontes falhando e ilegíveis, com motivo e nº de falhas; fontes boas não entram', () => {
    const { db, t } = setup();
    db.upsertSource(t.id, { url: 'https://ok', label: 'Loja OK', status: 'ok', lastValue: 10 });
    const bad = db.upsertSource(t.id, { url: 'https://b', label: 'Loja B', status: 'ok' });
    db.recordSourceResult(bad.id, { ok: false, error: 'O site bloqueou o acesso automático (HTTP 429).', at: iso(3) });
    db.recordSourceResult(bad.id, { ok: false, error: 'O site bloqueou o acesso automático (HTTP 429).', at: iso(2) });
    db.upsertSource(t.id, { url: 'https://js', label: 'Loja JS', status: 'unreadable', lastError: 'O preço não aparece no HTML da página (JavaScript).' });
    const s = computeStats(db, t.id, iso(24), NOW.toISOString());
    expect(s.sourceProblems).toEqual([
      { url: 'https://b', label: 'Loja B', status: 'failing', error: 'O site bloqueou o acesso automático (HTTP 429).', failures: 2, since: iso(3) },
      { url: 'https://js', label: 'Loja JS', status: 'unreadable', error: 'O preço não aparece no HTML da página (JavaScript).', failures: 0, since: undefined },
    ]);
    expect(s.sourcesOk).toBe(1);
  });
});

describe('renderSourceProblems', () => {
  it('texto determinístico com site, motivo e contagem; vazio se não há problemas', () => {
    expect(renderSourceProblems([])).toBe('');
    const txt = renderSourceProblems([
      { tracker: 'PS5 Slim Digital', problems: [{ url: 'https://b', label: 'Loja B', status: 'failing', error: 'bloqueou', failures: 3, since: '2026-03-10T09:00:00Z' }] },
      { tracker: 'iPhone', problems: [{ url: 'https://js.com/x', status: 'unreadable', error: 'montado por JavaScript', failures: 0 }] },
    ]);
    expect(txt).toContain('⚠️ Sites sem preço');
    expect(txt).toContain('PS5 Slim Digital');
    expect(txt).toContain('Loja B');
    expect(txt).toContain('bloqueou');
    expect(txt).toContain('3 verificações seguidas');
    expect(txt).toContain('iPhone');
    expect(txt).toContain('js.com'); // sem rótulo: usa o domínio
    expect(txt).toContain('montado por JavaScript');
  });
});

describe('generateDigest: sites sem preço entram no relatório', () => {
  it('sem alertas, mas com site sem preço: gera o relatório sem chamar a IA e deixa isso claro', async () => {
    const s = setup();
    const bad = s.db.upsertSource(s.t.id, { url: 'https://b', label: 'Loja B', status: 'ok' });
    s.db.recordSourceResult(bad.id, { ok: false, error: 'O site bloqueou o acesso automático (HTTP 429).', at: iso(1) });
    const r = await generateDigest(s.deps(true), 'daily');
    expect(r.sent).toBe(true);
    expect(s.chat).toHaveLength(0); // nada de IA: não há queda para resumir
    expect(r.text).toContain('Nenhum alerta de preço');
    expect(r.text).toContain('⚠️ Sites sem preço');
    expect(r.text).toContain('Loja B');
    expect(r.text).toContain('bloqueou');
    expect(s.db.listReports().map((x) => x.text)).toEqual([r.text]);
    expect(s.sent).toEqual([r.text]);
  });

  it('com alertas e sites sem preço: texto da IA + bloco de problemas anexado', async () => {
    const s = setup();
    s.db.addAlert({ trackerId: s.t.id, at: iso(2), text: 'queda', value: 3400, delivered: true });
    s.db.upsertSource(s.t.id, { url: 'https://js', label: 'Loja JS', status: 'unreadable', lastError: 'preço montado por JavaScript' });
    const r = await generateDigest(s.deps(false), 'daily');
    expect(r.text).toContain('RESUMO DAS QUEDAS');
    expect(r.text).toContain('⚠️ Sites sem preço');
    expect(r.text).toContain('Loja JS');
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).not.toContain('Loja JS'); // a IA só resume as quedas; os problemas são texto fixo
  });

  it('só fontes boas e sem alertas: nada a relatar', async () => {
    const s = setup();
    s.db.upsertSource(s.t.id, { url: 'https://ok', label: 'Loja OK', status: 'ok', lastValue: 10 });
    expect((await generateDigest(s.deps(true), 'daily')).sent).toBe(false);
    expect(s.sent).toEqual([]);
  });

  it('acompanhamento de outro período de resumo não entra', async () => {
    const s = setup();
    const w = s.db.createTracker(nt({ digest: 'weekly', name: 'Semanal' }));
    s.db.upsertSource(w.id, { url: 'https://js', label: 'Loja JS', status: 'unreadable', lastError: 'x' });
    expect((await generateDigest(s.deps(true), 'daily')).sent).toBe(false);
  });
});
