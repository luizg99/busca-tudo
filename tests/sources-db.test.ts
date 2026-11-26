import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/service/db';
import type { NewTracker } from '../src/shared/types';

const nt: NewTracker = {
  name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'daily',
};

describe('migração de um banco criado antes das fontes', () => {
  it('adiciona as colunas novas sem perder os dados antigos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-db-'));
    const file = join(dir, 'old.db');
    try {
      const old = new Database(file);
      old.exec(`
        CREATE TABLE trackers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL,
          include_json TEXT NOT NULL, exclude_json TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
          alert_condition_json TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
        CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
          at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, findings_json TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL NOT NULL);
        INSERT INTO trackers (name, kind, goal, include_json, exclude_json, interval_minutes, alert_condition_json, digest, created_at)
          VALUES ('Velho', 'price', 'g', '[]', '[]', 60, '{"type":"below_last"}', 'none', '2026-01-01T00:00:00Z');
        INSERT INTO checks (tracker_id, at, ok, findings_json, model, cost_usd) VALUES (1, '2026-01-01T00:00:00Z', 1, '[]', 'm', 0.03);
      `);
      old.close();

      const db = openDb(file);
      const old1 = db.listChecks(1)[0];
      expect(old1.sources).toEqual([]);
      expect(old1.mode).toBeUndefined();
      db.addCheck({ trackerId: 1, at: '2026-01-02T00:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'routine',
        sources: [{ url: 'https://x', ok: true, method: 'rule', value: 10 }] });
      const novo = db.listChecks(1)[0];
      expect(novo.mode).toBe('routine');
      expect(novo.sources).toEqual([{ url: 'https://x', ok: true, method: 'rule', value: 10 }]);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('fontes (sources)', () => {
  it('upsertSource cria e atualiza a mesma URL sem duplicar, guardando a regra', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const a = db.upsertSource(t.id, { url: 'https://loja/a', label: 'Loja A', rule: { type: 'regex', pattern: 'R\\$\\s*([\\d.,]+)' }, status: 'ok', lastValue: 100 });
    const b = db.upsertSource(t.id, { url: 'https://loja/a', label: 'Loja A (novo)', rule: { type: 'generic' }, status: 'ok' });
    expect(b.id).toBe(a.id);
    const list = db.listSources(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Loja A (novo)', rule: { type: 'generic' }, status: 'ok', consecutiveFailures: 0 });
  });

  it('recordSourceResult: falhas se acumulam, sucesso zera e guarda último valor/método', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const s = db.upsertSource(t.id, { url: 'https://loja/a', status: 'ok' });
    db.recordSourceResult(s.id, { ok: false, error: 'bloqueou (429)', at: '2026-01-01T10:00:00Z' });
    db.recordSourceResult(s.id, { ok: false, error: 'bloqueou (429)', at: '2026-01-01T11:00:00Z' });
    let cur = db.getSource(s.id)!;
    expect(cur).toMatchObject({ status: 'failing', consecutiveFailures: 2, lastError: 'bloqueou (429)', lastFailAt: '2026-01-01T11:00:00Z' });
    db.recordSourceResult(s.id, { ok: true, method: 'ai', value: 3500, at: '2026-01-01T12:00:00Z' });
    cur = db.getSource(s.id)!;
    expect(cur).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastValue: 3500, method: 'ai', lastOkAt: '2026-01-01T12:00:00Z' });
    expect(cur.lastError).toBeUndefined();
  });

  it('markSourceNotified guarda quando o último aviso foi enviado', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const s = db.upsertSource(t.id, { url: 'https://loja/a', status: 'ok' });
    db.markSourceNotified(s.id, '2026-01-01T12:00:00Z');
    expect(db.getSource(s.id)!.lastNotifiedAt).toBe('2026-01-01T12:00:00Z');
  });

  it('fonte "unreadable" guarda o motivo', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const s = db.upsertSource(t.id, { url: 'https://loja/js', status: 'unreadable', lastError: 'O preço não aparece no HTML da página (montado por JavaScript).' });
    expect(db.getSource(s.id)).toMatchObject({ status: 'unreadable', lastError: expect.stringContaining('JavaScript') });
  });

  it('lastDiscoveryAt considera só verificações de descoberta', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    expect(db.lastDiscoveryAt(t.id)).toBeUndefined();
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'discovery' });
    db.addCheck({ trackerId: t.id, at: '2026-01-01T11:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'routine' });
    expect(db.lastDiscoveryAt(t.id)).toBe('2026-01-01T10:00:00Z');
  });

  it('lastDiscoveryAt também considera a busca de fallback', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'discovery' });
    db.addCheck({ trackerId: t.id, at: '2026-01-01T12:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'fallback' });
    expect(db.lastDiscoveryAt(t.id)).toBe('2026-01-01T12:00:00Z');
  });

  it('upsertSource com status ok zera a contagem de falhas (a fonte voltou a ser lida)', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const s = db.upsertSource(t.id, { url: 'https://loja/a', status: 'ok' });
    db.recordSourceResult(s.id, { ok: false, error: 'x', at: '2026-01-01T10:00:00Z' });
    db.recordSourceResult(s.id, { ok: false, error: 'x', at: '2026-01-01T11:00:00Z' });
    db.upsertSource(t.id, { url: 'https://loja/a', status: 'ok', lastValue: 10 });
    expect(db.getSource(s.id)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it('apagar o acompanhamento apaga as fontes', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    db.upsertSource(t.id, { url: 'https://loja/a', status: 'ok' });
    db.deleteTracker(t.id);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });
});
