import { Client, LocalAuth } from 'whatsapp-web.js';
import type { Db } from './db';

export interface Transport {
  isReady(): boolean;
  sendToSelf(text: string): Promise<void>;
}

/** Espera antes de tentar reconectar o WhatsApp: 30s, 1min, 2min… com teto de 10 min. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** attempt, 600_000);
}

export class Notifier {
  /** Todas as entregas passam por esta fila única, então nunca há duas em paralelo. */
  private chain: Promise<unknown> = Promise.resolve();
  private sendTimeoutMs: number;

  constructor(
    private db: Db,
    private transport: Transport,
    private now: () => Date = () => new Date(),
    options: { sendTimeoutMs?: number } = {},
  ) {
    this.sendTimeoutMs = options.sendTimeoutMs ?? 45_000;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async deliver(text: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tempo esgotado ao enviar pelo WhatsApp.')), this.sendTimeoutMs);
    });
    try {
      await Promise.race([this.transport.sendToSelf(text), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Grava o alerta e tenta entregar; se não der, fica pendente para `flushPending`. */
  async send(trackerId: number, text: string, extra: { sourceUrl?: string; value?: number } = {}): Promise<void> {
    const id = this.db.addAlert({
      trackerId, at: this.now().toISOString(), text, sourceUrl: extra.sourceUrl, value: extra.value, delivered: false,
    });
    await this.enqueue(async () => {
      // um flush anterior pode já ter entregado este alerta enquanto ele esperava na fila
      if (!this.db.pendingAlerts().some((a) => a.id === id) || !this.transport.isReady()) return;
      try {
        await this.deliver(text);
        this.db.markDelivered(id);
      } catch {
        /* continua pendente */
      }
    });
  }

  /** Texto avulso (ex.: resumo periódico): não vira alerta nem fica pendente. */
  async sendInfo(text: string): Promise<boolean> {
    if (!this.transport.isReady()) return false;
    try {
      await this.enqueue(() => this.deliver(text));
      return true;
    } catch {
      return false;
    }
  }

  async flushPending(): Promise<number> {
    if (!this.transport.isReady()) return 0;
    return this.enqueue(async () => {
      let delivered = 0;
      for (const a of this.db.pendingAlerts()) {
        if (!this.transport.isReady()) break;
        try {
          await this.deliver(a.text);
          this.db.markDelivered(a.id);
          delivered++;
        } catch {
          /* mantém pendente e segue */
        }
      }
      return delivered;
    });
  }
}

export type WhatsAppStatus = 'disconnected' | 'qr' | 'ready';

export function createWhatsAppTransport(
  authDir: string,
  onQr: (qr: string) => void,
  onStatus: (s: WhatsAppStatus) => void,
  log: (msg: string) => void = () => undefined,
): Transport & { start(): Promise<void>; stop(): Promise<void> } {
  let ready = false;
  let stopped = false;
  let attempt = 0;
  let client: Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  function scheduleRestart(reason: string): void {
    if (stopped || retryTimer) return;
    const wait = nextBackoffMs(attempt++);
    log(`whatsapp: ${reason}; nova tentativa em ${Math.round(wait / 1000)}s`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, wait);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const old = client;
    client = undefined;
    ready = false;
    await old?.destroy().catch(() => undefined);
    const c = new Client({
      authStrategy: new LocalAuth({ dataPath: authDir }),
      puppeteer: { headless: true },
    });
    client = c;
    c.on('qr', (qr) => { ready = false; onQr(qr); onStatus('qr'); });
    c.on('ready', () => { ready = true; attempt = 0; onStatus('ready'); });
    c.on('disconnected', (why) => { ready = false; onStatus('disconnected'); scheduleRestart(`desconectado (${why})`); });
    c.on('auth_failure', (msg) => { ready = false; onStatus('disconnected'); scheduleRestart(`falha de autenticação (${msg})`); });
    try {
      await c.initialize();
    } catch (e) {
      onStatus('disconnected');
      scheduleRestart(`falha ao iniciar (${(e as Error).message})`);
    }
  }

  return {
    isReady: () => ready,
    async sendToSelf(text: string) {
      const me = client?.info?.wid?._serialized;
      if (!ready || !client || !me) throw new Error('WhatsApp não está conectado.');
      await client.sendMessage(me, text);
    },
    async start() { stopped = false; await connect(); },
    async stop() {
      stopped = true;
      ready = false;
      if (retryTimer) clearTimeout(retryTimer);
      await client?.destroy().catch(() => undefined);
    },
  };
}
