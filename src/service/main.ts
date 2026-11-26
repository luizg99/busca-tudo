import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApi, DEFAULT_MODELS, readSettings } from './api';
import { estimateCostUsd, overLimit, type Usage } from './cost';
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
      if (s !== 'qr') waQr = undefined; // um QR antigo não vale mais
      if (s === 'ready') void notifier.flushPending();
    },
    log,
  );
  notifier = new Notifier(db, transport, now, { getTarget: () => db.getSetting('alert_number') || undefined });

  // Limites padrão na primeira execução, para o gasto nunca ficar sem teto sem o usuário saber.
  if (db.getSetting('limit_day_usd') === undefined) db.setSetting('limit_day_usd', '2');
  if (db.getSetting('limit_month_usd') === undefined) db.setSetting('limit_month_usd', '30');
  const recordSpend = (source: string) => (u: Usage) => db.addSpend({ at: now().toISOString(), usd: estimateCostUsd(u), source });

  const runCheckNow = async (id: number) => {
    if (!llm) return { ok: false, alerted: false, baseline: false, error: 'Chave da Anthropic não configurada.' };
    const lim = overLimit(db, now());
    if (lim.over) return { ok: false, alerted: false, baseline: false, error: `Limite de custo ${lim.period === 'day' ? 'diário' : 'mensal'} atingido.` };
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
    newSetupSession: () => (llm ? new SetupSession(llm, readSettings(db).models.setup ?? DEFAULT_MODELS.setup, recordSpend('setup')) : undefined),
    runCheckNow,
    sendTestMessage: async () => {
      if (waStatus !== 'ready') return { ok: false, error: 'O WhatsApp não está conectado. Escaneie o QR em Configurações.' };
      const delivered = await notifier.sendInfo('✅ Teste do busca-tudo: se você está lendo isto, os avisos vão chegar por aqui.');
      return delivered ? { ok: true } : { ok: false, error: 'Não consegui enviar a mensagem de teste. Veja o service.log.' };
    },
    buildId: String(statSync(__filename).mtimeMs),
    shutdown: () => void shutdown(),
  });

  const port = Number(process.env.BUSCA_TUDO_PORT ?? DEFAULT_PORT);
  server.on('error', (e: NodeJS.ErrnoException) => {
    log(`api error: ${e.code ?? e.message}`);
    if (e.code === 'EADDRINUSE') process.exit(1);
  });
  // Só começa a trabalhar depois de conseguir a porta: uma segunda instância morre por EADDRINUSE
  // sem ter chamado a IA nem aberto o WhatsApp (que disputaria o mesmo perfil do Chrome).
  server.listen(port, '127.0.0.1', () => {
    log(`api listening on 127.0.0.1:${port}`);
    scheduler.start();
    setInterval(() => void notifier.flushPending(), 60_000);
    setInterval(() => {
      if (!llm) return;
      const s = readSettings(db);
      for (const period of dueDigests(db, now())) {
        generateDigest({ db, llm, notifier, model: s.models.routine, sendWhatsApp: s.sendReportsToWhatsApp, now, onUsage: recordSpend('digest') }, period).catch((e) =>
          log(`digest ${period} failed: ${e}`),
        );
      }
    }, 5 * 60_000);
    transport.start().catch((e) => log(`whatsapp start failed: ${e}`));
  });

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

