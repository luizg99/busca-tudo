import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateNewTracker, type NewTracker } from '../shared/types';
import { overLimit, spentSince } from './cost';
import type { Db } from './db';
import type { CheckResultSummary } from './pipeline';
import { computeStats } from './reports';
import type { SetupSession } from './setupChat';
import type { WhatsAppStatus } from './notifier';
import { normalizePhone } from './phone';

export const DEFAULT_MODELS = {
  setup: 'claude-sonnet-5-5',
  routine: 'claude-haiku-5-5',
  escalate: 'claude-sonnet-5-5',
};

export interface ApiDeps {
  token: string;
  db: Db;
  now: () => Date;
  hasApiKey(): boolean;
  setApiKey(key: string): Promise<void>;
  whatsappStatus(): { status: WhatsAppStatus; qr?: string };
  newSetupSession(): SetupSession | undefined;
  runCheckNow(trackerId: number): Promise<CheckResultSummary>;
  /** Identifica o código em execução; o app usa para reiniciar um serviço desatualizado. */
  buildId: string;
  shutdown(): void;
  /** Envia uma mensagem de teste pelo WhatsApp conectado. */
  sendTestMessage(): Promise<{ ok: boolean; error?: string }>;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Corpo da requisição grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function readSettings(db: Db) {
  const num = (k: string) => {
    const v = db.getSetting(k);
    return v === undefined || v === '' ? undefined : Number(v);
  };
  return {
    models: {
      setup: db.getSetting('model_setup') ?? DEFAULT_MODELS.setup,
      routine: db.getSetting('model_routine') ?? DEFAULT_MODELS.routine,
      escalate: db.getSetting('model_escalate') ?? DEFAULT_MODELS.escalate,
    },
    limitDayUsd: num('limit_day_usd'),
    limitMonthUsd: num('limit_month_usd'),
    sendReportsToWhatsApp: db.getSetting('send_reports_whatsapp') === '1',
    alertNumber: db.getSetting('alert_number') || undefined,
  };
}

export function createApi(deps: ApiDeps): Server {
  const { db } = deps;
  const sessions = new Map<string, SetupSession>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req, deps.token)) return send(res, 401, { error: 'Não autorizado.' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/status') {
      const wa = deps.whatsappStatus();
      const lastCheck = db.raw.prepare('SELECT MAX(at) AS at FROM checks').get() as { at: string | null };
      return send(res, 200, {
        running: true,
        buildId: deps.buildId,
        whatsapp: wa.status,
        ...(wa.qr ? { qr: wa.qr } : {}),
        hasApiKey: deps.hasApiKey(),
        lastCheckAt: lastCheck.at ?? undefined,
        overLimit: overLimit(db, deps.now()).over,
        spentDayUsd: spentSince(db, new Date(deps.now().getFullYear(), deps.now().getMonth(), deps.now().getDate()).toISOString()),
        spentMonthUsd: spentSince(db, new Date(deps.now().getFullYear(), deps.now().getMonth(), 1).toISOString()),
      });
    }

    if (method === 'POST' && path === '/whatsapp/test') {
      return send(res, 200, await deps.sendTestMessage());
    }

    if (method === 'POST' && path === '/shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => deps.shutdown(), 50);
      return;
    }

    if (path === '/settings') {
      if (method === 'GET') return send(res, 200, { ...readSettings(db), hasApiKey: deps.hasApiKey() });
      if (method === 'PUT') {
        const b = await readBody(req);
        if (typeof b.anthropicApiKey === 'string' && b.anthropicApiKey.trim()) await deps.setApiKey(b.anthropicApiKey.trim());
        for (const [bodyKey, settingKey] of [['setup', 'model_setup'], ['routine', 'model_routine'], ['escalate', 'model_escalate']] as const) {
          const v = b.models?.[bodyKey];
          if (typeof v === 'string' && v.trim()) db.setSetting(settingKey, v.trim());
        }
        if (b.limitDayUsd !== undefined) db.setSetting('limit_day_usd', b.limitDayUsd === null ? '' : String(Number(b.limitDayUsd)));
        if (b.limitMonthUsd !== undefined) db.setSetting('limit_month_usd', b.limitMonthUsd === null ? '' : String(Number(b.limitMonthUsd)));
        if (b.alertNumber !== undefined) {
          if (b.alertNumber === null || String(b.alertNumber).trim() === '') db.setSetting('alert_number', '');
          else {
            const n = normalizePhone(String(b.alertNumber));
            if (!n) throw new HttpError(400, 'Esse número não parece válido. Informe com DDD, por exemplo 11 99999-0000.');
            db.setSetting('alert_number', n);
          }
        }
        if (b.sendReportsToWhatsApp !== undefined) db.setSetting('send_reports_whatsapp', b.sendReportsToWhatsApp ? '1' : '0');
        return send(res, 200, { ...readSettings(db), hasApiKey: deps.hasApiKey() });
      }
    }

    if (path === '/trackers') {
      if (method === 'GET') return send(res, 200, db.listTrackers());
      if (method === 'POST') {
        const b = (await readBody(req)) as NewTracker;
        const errors = validateNewTracker(b);
        if (errors.length) return send(res, 400, { error: errors.join(' '), errors });
        return send(res, 201, db.createTracker(b));
      }
    }

    if ((m = path.match(/^\/trackers\/(\d+)$/))) {
      const id = Number(m[1]);
      const cur = db.getTracker(id);
      if (!cur) return send(res, 404, { error: 'Acompanhamento não encontrado.' });
      if (method === 'DELETE') {
        db.deleteTracker(id);
        return send(res, 204);
      }
      if (method === 'PATCH') {
        const b = await readBody(req);
        const merged = { ...cur, ...b, id: cur.id } as typeof cur;
        const errors = validateNewTracker(merged);
        if (errors.length) return send(res, 400, { error: errors.join(' '), errors });
        const { id: _i, createdAt: _c, ...patch } = merged;
        return send(res, 200, db.updateTracker(id, patch));
      }
    }

    if (method === 'POST' && (m = path.match(/^\/trackers\/(\d+)\/check$/))) {
      if (!db.getTracker(Number(m[1]))) return send(res, 404, { error: 'Acompanhamento não encontrado.' });
      return send(res, 200, await deps.runCheckNow(Number(m[1])));
    }

    if (method === 'GET' && (m = path.match(/^\/trackers\/(\d+)\/checks$/))) {
      return send(res, 200, db.listChecks(Number(m[1]), Number(url.searchParams.get('limit') ?? 100)));
    }

    if (method === 'GET' && (m = path.match(/^\/trackers\/(\d+)\/stats$/))) {
      const to = url.searchParams.get('to') ?? deps.now().toISOString();
      const from = url.searchParams.get('from') ?? new Date(Date.parse(to) - 7 * 24 * 3600_000).toISOString();
      return send(res, 200, computeStats(db, Number(m[1]), from, to));
    }

    if (method === 'GET' && path === '/reports') {
      return send(res, 200, db.listReports({ since: url.searchParams.get('since') ?? undefined }));
    }

    if (method === 'POST' && (m = path.match(/^\/setup\/([\w-]+)\/message$/))) {
      const b = await readBody(req);
      if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'Mensagem vazia.');
      let session = sessions.get(m[1]);
      if (!session) {
        session = deps.newSetupSession();
        if (!session) throw new HttpError(409, 'Configure a chave da Anthropic para conversar com a IA.');
        sessions.set(m[1], session);
      }
      return send(res, 200, await session.send(b.text));
    }

    if (method === 'POST' && (m = path.match(/^\/setup\/([\w-]+)\/confirm$/))) {
      const session = sessions.get(m[1]);
      if (!session?.pending) throw new HttpError(409, 'Não há proposta pendente para confirmar.');
      const created = db.createTracker(session.pending);
      sessions.delete(m[1]);
      return send(res, 201, created);
    }

    return send(res, 404, { error: 'Rota não encontrada.' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: 'Erro interno.' });
    });
  });
}
