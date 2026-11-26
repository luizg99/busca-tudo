import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApi, DEFAULT_MODELS, readSettings } from './api';
import { openDb } from './db';
import { loadApiKey, saveApiKey } from './secrets';
import { createAnthropicClient, type LlmClient } from './llm';
import { createWhatsAppTransport, Notifier, type WhatsAppStatus } from './notifier';
import { runCheck } from './pipeline';
import { Scheduler } from './scheduler';
import { dueDigests, generateDigest } from './reports';
import { SetupSession } from './setupChat';

export const DEFAULT_PORT = 47831;

export function defaultDataDir(): string {
  return process.env.BUSCA_TUDO_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'busca-tudo');
}

function loadOrCreateToken(dir: string): string {
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token, 'utf8');
  return token;
}

async function main(): Promise<void> {
  const dir = defaultDataDir();
  mkdirSync(dir, { recursive: true });
  const log = (msg: string) => {
    try {
      appendFileSync(join(dir, 'service.log'), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* sem log */
    }
  };
  process.on('uncaughtException', (e) => log(`uncaughtException: ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e}`));

  const token = loadOrCreateToken(dir);
  const db = openDb(join(dir, 'busca-tudo.db'));
  const now = () => new Date();

  let llm: LlmClient | undefined;
  const key = await loadApiKey(dir);
  if (key) llm = createAnthropicClient(key);

  let waStatus: WhatsAppStatus = 'disconnected';
  let waQr: string | undefined;
  // eslint-disable-next-line prefer-const
  let notifier: Notifier;
  const transport = createWhatsAppTransport(
    join(dir, 'wa-auth'),
    (qr) => { waQr = qr; },
    (s) => {
      waStatus = s;
      if (s === 'ready') {
        waQr = undefined;
        void notifier.flushPending();
      }
    },
  );
  notifier = new Notifier(db, transport, now);

  const runCheckNow = async (id: number) => {
    if (!llm) return { ok: false, alerted: false, baseline: false, error: 'Chave da Anthropic não configurada.' };
    return runCheck({ db, llm, notifier, models: readSettings(db).models, now }, id);
  };

  const scheduler = new Scheduler({
    db,
    now,
    run: async (id) => {
      if (!llm) return;
      const r = await runCheckNow(id);
      log(`check tracker=${id} ok=${r.ok} alerted=${r.alerted}${r.error ? ` error=${r.error}` : ''}`);
    },
  });

  const server = createApi({
    token,
    db,
    now,
    hasApiKey: () => !!llm,
    setApiKey: async (k) => {
      await saveApiKey(dir, k);
      llm = createAnthropicClient(k);
    },
    whatsappStatus: () => ({ status: waStatus, ...(waQr ? { qr: waQr } : {}) }),
    newSetupSession: () => (llm ? new SetupSession(llm, readSettings(db).models.setup ?? DEFAULT_MODELS.setup) : undefined),
    runCheckNow,
  });

  const port = Number(process.env.BUSCA_TUDO_PORT ?? DEFAULT_PORT);
  server.on('error', (e: NodeJS.ErrnoException) => {
    log(`api error: ${e.code ?? e.message}`);
    if (e.code === 'EADDRINUSE') process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => log(`api listening on 127.0.0.1:${port}`));

  scheduler.start();
  setInterval(() => void notifier.flushPending(), 60_000);
  setInterval(() => {
    if (!llm) return;
    const s = readSettings(db);
    for (const period of dueDigests(db, now())) {
      generateDigest({ db, llm, notifier, model: s.models.routine, sendWhatsApp: s.sendReportsToWhatsApp, now }, period).catch((e) =>
        log(`digest ${period} failed: ${e}`),
      );
    }
  }, 5 * 60_000);

  transport.start().catch((e) => log(`whatsapp start failed: ${e}`));

  const shutdown = async () => {
    scheduler.stop();
    server.close();
    await transport.stop().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  void main();
}

