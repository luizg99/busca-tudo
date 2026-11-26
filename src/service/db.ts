import Database from 'better-sqlite3';
import type { AlertCondition, Finding, NewTracker, Tracker } from '../shared/types';

export interface CheckInput {
  trackerId: number;
  at: string;
  ok: boolean;
  error?: string;
  findings: Finding[];
  model: string;
  costUsd: number;
}
export interface CheckRow extends CheckInput {
  id: number;
}
export interface AlertInput {
  trackerId: number;
  at: string;
  text: string;
  sourceUrl?: string;
  value?: number;
  delivered: boolean;
}
export interface AlertRow extends AlertInput {
  id: number;
}
export interface ReportInput {
  trackerId?: number;
  period: string;
  text: string;
  at: string;
}
export interface ReportRow extends ReportInput {
  id: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trackers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL,
  include_json TEXT NOT NULL, exclude_json TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
  alert_condition_json TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, findings_json TEXT NOT NULL,
  model TEXT NOT NULL, cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_tracker ON checks(tracker_id, at);
CREATE TABLE IF NOT EXISTS seen (
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  key TEXT NOT NULL, PRIMARY KEY (tracker_id, key)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  at TEXT NOT NULL, text TEXT NOT NULL, source_url TEXT, value REAL, delivered INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tracker_id INTEGER, period TEXT NOT NULL,
  text TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type TrackerPatch = Partial<NewTracker & { status: Tracker['status'] }>;

export function openDb(path: string) {
  const raw = new Database(path);
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  const toTracker = (r: any): Tracker => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    goal: r.goal,
    include: JSON.parse(r.include_json),
    exclude: JSON.parse(r.exclude_json),
    intervalMinutes: r.interval_minutes,
    alertCondition: JSON.parse(r.alert_condition_json) as AlertCondition,
    digest: r.digest,
    status: r.status,
    createdAt: r.created_at,
  });
  const toCheck = (r: any): CheckRow => ({
    id: r.id,
    trackerId: r.tracker_id,
    at: r.at,
    ok: !!r.ok,
    error: r.error ?? undefined,
    findings: JSON.parse(r.findings_json),
    model: r.model,
    costUsd: r.cost_usd,
  });
  const toAlert = (r: any): AlertRow => ({
    id: r.id,
    trackerId: r.tracker_id,
    at: r.at,
    text: r.text,
    sourceUrl: r.source_url ?? undefined,
    value: r.value ?? undefined,
    delivered: !!r.delivered,
  });

  const api = {
    raw,
    createTracker(t: NewTracker): Tracker {
      const info = raw
        .prepare(
          `INSERT INTO trackers (name, kind, goal, include_json, exclude_json, interval_minutes, alert_condition_json, digest, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          t.name, t.kind, t.goal, JSON.stringify(t.include), JSON.stringify(t.exclude),
          t.intervalMinutes, JSON.stringify(t.alertCondition), t.digest, new Date().toISOString(),
        );
      return api.getTracker(Number(info.lastInsertRowid))!;
    },
    listTrackers(): Tracker[] {
      return raw.prepare('SELECT * FROM trackers ORDER BY id').all().map(toTracker);
    },
    getTracker(id: number): Tracker | undefined {
      const r = raw.prepare('SELECT * FROM trackers WHERE id = ?').get(id);
      return r ? toTracker(r) : undefined;
    },
    updateTracker(id: number, patch: TrackerPatch): Tracker {
      const cur = api.getTracker(id);
      if (!cur) throw new Error(`Acompanhamento ${id} não existe`);
      const n = { ...cur, ...patch };
      raw
        .prepare(
          `UPDATE trackers SET name=?, kind=?, goal=?, include_json=?, exclude_json=?, interval_minutes=?,
           alert_condition_json=?, digest=?, status=? WHERE id=?`,
        )
        .run(
          n.name, n.kind, n.goal, JSON.stringify(n.include), JSON.stringify(n.exclude),
          n.intervalMinutes, JSON.stringify(n.alertCondition), n.digest, n.status, id,
        );
      return api.getTracker(id)!;
    },
    deleteTracker(id: number): void {
      raw.prepare('DELETE FROM trackers WHERE id = ?').run(id);
    },
    addCheck(c: CheckInput): number {
      const info = raw
        .prepare('INSERT INTO checks (tracker_id, at, ok, error, findings_json, model, cost_usd) VALUES (?,?,?,?,?,?,?)')
        .run(c.trackerId, c.at, c.ok ? 1 : 0, c.error ?? null, JSON.stringify(c.findings), c.model, c.costUsd);
      return Number(info.lastInsertRowid);
    },
    listChecks(trackerId: number, limit = 100): CheckRow[] {
      return raw
        .prepare('SELECT * FROM checks WHERE tracker_id = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(trackerId, limit)
        .map(toCheck);
    },
    listChecksBetween(trackerId: number, fromIso: string, toIso: string): CheckRow[] {
      return raw
        .prepare('SELECT * FROM checks WHERE tracker_id = ? AND at >= ? AND at <= ? ORDER BY at, id')
        .all(trackerId, fromIso, toIso)
        .map(toCheck);
    },
    lastCheckAt(trackerId: number): string | undefined {
      const r = raw
        .prepare('SELECT at FROM checks WHERE tracker_id = ? ORDER BY at DESC, id DESC LIMIT 1')
        .get(trackerId) as any;
      return r?.at;
    },
    lastValue(trackerId: number): number | undefined {
      const rows = raw
        .prepare('SELECT findings_json FROM checks WHERE tracker_id = ? AND ok = 1 ORDER BY at DESC, id DESC')
        .all(trackerId) as any[];
      for (const r of rows) {
        const vals = (JSON.parse(r.findings_json) as Finding[])
          .filter((f) => f.found && typeof f.value === 'number')
          .map((f) => f.value as number);
        if (vals.length) return Math.min(...vals);
      }
      return undefined;
    },
    markSeen(trackerId: number, key: string): boolean {
      const info = raw.prepare('INSERT OR IGNORE INTO seen (tracker_id, key) VALUES (?, ?)').run(trackerId, key);
      return info.changes > 0;
    },
    addAlert(a: AlertInput): number {
      const info = raw
        .prepare('INSERT INTO alerts (tracker_id, at, text, source_url, value, delivered) VALUES (?,?,?,?,?,?)')
        .run(a.trackerId, a.at, a.text, a.sourceUrl ?? null, a.value ?? null, a.delivered ? 1 : 0);
      return Number(info.lastInsertRowid);
    },
    pendingAlerts(): AlertRow[] {
      return raw.prepare('SELECT * FROM alerts WHERE delivered = 0 ORDER BY id').all().map(toAlert);
    },
    listAlerts(trackerId: number, fromIso: string, toIso: string): AlertRow[] {
      return raw
        .prepare('SELECT * FROM alerts WHERE tracker_id = ? AND at >= ? AND at <= ? ORDER BY at')
        .all(trackerId, fromIso, toIso)
        .map(toAlert);
    },
    markDelivered(id: number): void {
      raw.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').run(id);
    },
    lastAlertAt(trackerId: number): string | undefined {
      const r = raw
        .prepare('SELECT at FROM alerts WHERE tracker_id = ? ORDER BY at DESC, id DESC LIMIT 1')
        .get(trackerId) as any;
      return r?.at;
    },
    getSetting(key: string): string | undefined {
      const r = raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
      return r?.value;
    },
    setSetting(key: string, value: string): void {
      raw
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
    },
    addReport(r: ReportInput): number {
      const info = raw
        .prepare('INSERT INTO reports (tracker_id, period, text, at) VALUES (?,?,?,?)')
        .run(r.trackerId ?? null, r.period, r.text, r.at);
      return Number(info.lastInsertRowid);
    },
    listReports(filter: { since?: string } = {}): ReportRow[] {
      const rows = filter.since
        ? raw.prepare('SELECT * FROM reports WHERE at >= ? ORDER BY at').all(filter.since)
        : raw.prepare('SELECT * FROM reports ORDER BY at').all();
      return (rows as any[]).map((r) => ({
        id: r.id,
        trackerId: r.tracker_id ?? undefined,
        period: r.period,
        text: r.text,
        at: r.at,
      }));
    },
    close(): void {
      raw.close();
    },
  };
  return api;
}

export type Db = ReturnType<typeof openDb>;
