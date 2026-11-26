import Database from 'better-sqlite3';
import type { AlertCondition, CheckMode, Finding, NewTracker, PriceRule, ReadMethod, SourceResult, SourceStatus, Tracker } from '../shared/types';
import { reliableValue } from './decide';

export interface CheckInput {
  trackerId: number;
  at: string;
  ok: boolean;
  error?: string;
  findings: Finding[];
  model: string;
  costUsd: number;
  mode?: CheckMode;
  sources?: SourceResult[];
}
export interface CheckRow extends Omit<CheckInput, 'sources'> {
  id: number;
  sources: SourceResult[];
}
/** De onde a oferta veio (site desconhecido que leva a uma loja confiável), para mostrar loja e cupom nas leituras seguintes. */
export interface SourceOrigin { store?: string; storeUrl?: string; coupon?: string; via?: string; viaUrl?: string; payment?: 'vista' | 'parcelado'; paymentNote?: string }

export interface SourceRow {
  id: number;
  trackerId: number;
  url: string;
  label?: string;
  rule?: PriceRule;
  status: SourceStatus;
  method?: ReadMethod;
  lastValue?: number;
  lastOkAt?: string;
  lastFailAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  lastNotifiedAt?: string;
  /** Quando começou a sequência atual de falhas. */
  failingSince?: string;
  /** Fonte de site desconhecido cujo link de saída foi conferido e leva a uma loja confiável. */
  trustedVia?: boolean;
  origin?: SourceOrigin;
  createdAt: string;
}
export interface SourceInput {
  trustedVia?: boolean;
  /** undefined mantém o que já existe; null apaga. */
  origin?: SourceOrigin | null;
  url: string;
  label?: string;
  rule?: PriceRule;
  status: SourceStatus;
  lastValue?: number;
  lastError?: string;
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
  created_at TEXT NOT NULL, only_trusted INTEGER NOT NULL DEFAULT 1
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
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  url TEXT NOT NULL, label TEXT, rule_json TEXT, status TEXT NOT NULL, method TEXT,
  last_value REAL, last_ok_at TEXT, last_fail_at TEXT, last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_notified_at TEXT, failing_since TEXT, created_at TEXT NOT NULL,
  UNIQUE (tracker_id, url)
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, usd REAL NOT NULL, source TEXT NOT NULL
);
`;

type TrackerPatch = Partial<NewTracker & { status: Tracker['status'] }>;

export function openDb(path: string) {
  const raw = new Database(path);
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);
  // Bancos criados antes das fontes: adiciona as colunas novas sem perder dados.
  const ensureColumn = (table: string, column: string, type: string) => {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  ensureColumn('checks', 'sources_json', 'TEXT');
  ensureColumn('checks', 'mode', 'TEXT');
  ensureColumn('sources', 'failing_since', 'TEXT');
  ensureColumn('sources', 'trusted_via', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sources', 'origin_json', 'TEXT');
  // acompanhamentos que já existiam seguem sem restrição (só os novos nascem com "só lojas confiáveis")
  ensureColumn('trackers', 'only_trusted', 'INTEGER NOT NULL DEFAULT 0');

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
    onlyTrusted: r.only_trusted !== 0,
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
    mode: r.mode ?? undefined,
    sources: r.sources_json ? JSON.parse(r.sources_json) : [],
  });
  const toSource = (r: any): SourceRow => ({
    id: r.id,
    trackerId: r.tracker_id,
    url: r.url,
    label: r.label ?? undefined,
    rule: r.rule_json ? JSON.parse(r.rule_json) : undefined,
    status: r.status,
    method: r.method ?? undefined,
    lastValue: r.last_value ?? undefined,
    lastOkAt: r.last_ok_at ?? undefined,
    lastFailAt: r.last_fail_at ?? undefined,
    lastError: r.last_error ?? undefined,
    consecutiveFailures: r.consecutive_failures,
    lastNotifiedAt: r.last_notified_at ?? undefined,
    failingSince: r.failing_since ?? undefined,
    trustedVia: !!r.trusted_via,
    origin: r.origin_json ? (JSON.parse(r.origin_json) as SourceOrigin) : undefined,
    createdAt: r.created_at,
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
          `INSERT INTO trackers (name, kind, goal, include_json, exclude_json, interval_minutes, alert_condition_json, digest, created_at, only_trusted)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          t.name, t.kind, t.goal, JSON.stringify(t.include), JSON.stringify(t.exclude),
          t.intervalMinutes, JSON.stringify(t.alertCondition), t.digest, new Date().toISOString(), t.onlyTrusted === false ? 0 : 1,
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
           alert_condition_json=?, digest=?, status=?, only_trusted=? WHERE id=?`,
        )
        .run(
          n.name, n.kind, n.goal, JSON.stringify(n.include), JSON.stringify(n.exclude),
          n.intervalMinutes, JSON.stringify(n.alertCondition), n.digest, n.status, n.onlyTrusted === false ? 0 : 1, id,
        );
      return api.getTracker(id)!;
    },
    deleteTracker(id: number): void {
      raw.prepare('DELETE FROM trackers WHERE id = ?').run(id);
    },
    addCheck(c: CheckInput): number {
      const info = raw
        .prepare('INSERT INTO checks (tracker_id, at, ok, error, findings_json, model, cost_usd, mode, sources_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(c.trackerId, c.at, c.ok ? 1 : 0, c.error ?? null, JSON.stringify(c.findings), c.model, c.costUsd, c.mode ?? null,
          c.sources ? JSON.stringify(c.sources) : null);
      return Number(info.lastInsertRowid);
    },
    listChecks(trackerId: number, limit = 100): CheckRow[] {
      return raw
        .prepare('SELECT * FROM checks WHERE tracker_id = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(trackerId, limit)
        .map(toCheck);
    },
    getCheck(trackerId: number, id: number): CheckRow | undefined {
      const r = raw.prepare('SELECT * FROM checks WHERE id = ? AND tracker_id = ?').get(id, trackerId);
      return r ? toCheck(r) : undefined;
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
        const v = reliableValue(JSON.parse(r.findings_json));
        if (v !== undefined) return v;
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
    /** Gastos de IA que não pertencem a uma verificação (conversa de cadastro, resumos). */
    addSpend(s: { at: string; usd: number; source: string }): void {
      raw.prepare('INSERT INTO spend (at, usd, source) VALUES (?,?,?)').run(s.at, s.usd, s.source);
    },
    lastDiscoveryAt(trackerId: number): string | undefined {
      const r = raw
        .prepare("SELECT at FROM checks WHERE tracker_id = ? AND ok = 1 AND mode IN ('discovery', 'fallback') ORDER BY at DESC, id DESC LIMIT 1")
        .get(trackerId) as any;
      return r?.at;
    },
    /** Última tentativa de busca completa (bem-sucedida ou não): base do intervalo de espera depois de uma falha. */
    lastDiscoveryAttempt(trackerId: number): { at: string; ok: boolean } | undefined {
      const r = raw
        .prepare("SELECT at, ok FROM checks WHERE tracker_id = ? AND mode IN ('discovery', 'fallback') ORDER BY at DESC, id DESC LIMIT 1")
        .get(trackerId) as any;
      return r ? { at: r.at, ok: !!r.ok } : undefined;
    },
    upsertSource(trackerId: number, s: SourceInput): SourceRow {
      const existing = raw.prepare('SELECT * FROM sources WHERE tracker_id = ? AND url = ?').get(trackerId, s.url) as any;
      if (existing) {
        raw
          .prepare('UPDATE sources SET label = ?, rule_json = ?, status = ?, last_value = ?, last_error = ?, consecutive_failures = ?, failing_since = ?, last_notified_at = ?, trusted_via = ?, origin_json = ? WHERE id = ?')
          .run(s.label ?? existing.label, s.rule ? JSON.stringify(s.rule) : existing.rule_json, s.status,
            s.lastValue ?? existing.last_value, s.status === 'ok' ? null : s.lastError ?? existing.last_error,
            s.status === 'ok' ? 0 : existing.consecutive_failures, s.status === 'ok' ? null : existing.failing_since,
            s.status === 'ok' ? null : existing.last_notified_at, // voltou a funcionar: um problema futuro é um episódio novo
            s.trustedVia === undefined ? existing.trusted_via : s.trustedVia ? 1 : 0,
            s.origin === undefined ? existing.origin_json : s.origin ? JSON.stringify(s.origin) : null, existing.id);
        return api.getSource(existing.id)!;
      }
      const info = raw
        .prepare('INSERT INTO sources (tracker_id, url, label, rule_json, status, last_value, last_error, created_at, trusted_via, origin_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(trackerId, s.url, s.label ?? null, s.rule ? JSON.stringify(s.rule) : null, s.status, s.lastValue ?? null, s.lastError ?? null, new Date().toISOString(), s.trustedVia ? 1 : 0, s.origin ? JSON.stringify(s.origin) : null);
      return api.getSource(Number(info.lastInsertRowid))!;
    },
    getSource(id: number): SourceRow | undefined {
      const r = raw.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      return r ? toSource(r) : undefined;
    },
    listSources(trackerId: number): SourceRow[] {
      return raw.prepare('SELECT * FROM sources WHERE tracker_id = ? ORDER BY id').all(trackerId).map(toSource);
    },
    /** Registra o resultado da leitura numa verificação: falhas se acumulam, sucesso zera. */
    recordSourceResult(id: number, r: { ok: boolean; method?: ReadMethod; value?: number; error?: string; at: string }): void {
      if (r.ok) {
        raw
          .prepare("UPDATE sources SET status = 'ok', consecutive_failures = 0, method = ?, last_value = ?, last_ok_at = ?, last_error = NULL, failing_since = NULL, last_notified_at = NULL WHERE id = ?")
          .run(r.method ?? null, r.value ?? null, r.at, id);
      } else {
        raw
          .prepare("UPDATE sources SET status = 'failing', consecutive_failures = consecutive_failures + 1, last_fail_at = ?, last_error = ?, failing_since = COALESCE(failing_since, ?) WHERE id = ?")
          .run(r.at, r.error ?? null, r.at, id);
      }
    },
    /** Apaga as fontes aprendidas (ex.: quando o acompanhamento muda de produto). */
    /** A busca do dia manda: fica só o que ela trouxe (as que continuam mantêm a regra aprendida). */
    keepOnlySources(trackerId: number, urls: string[]): void {
      const keep = new Set(urls);
      for (const s of api.listSources(trackerId)) if (!keep.has(s.url)) raw.prepare('DELETE FROM sources WHERE id = ?').run(s.id);
    },
    deleteSources(trackerId: number): void {
      raw.prepare('DELETE FROM sources WHERE tracker_id = ?').run(trackerId);
    },
    markSourceNotified(id: number, at: string): void {
      raw.prepare('UPDATE sources SET last_notified_at = ? WHERE id = ?').run(at, id);
    },
    lastAlert(trackerId: number): AlertRow | undefined {
      const r = raw
        .prepare('SELECT * FROM alerts WHERE tracker_id = ? ORDER BY at DESC, id DESC LIMIT 1')
        .get(trackerId);
      return r ? toAlert(r) : undefined;
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
