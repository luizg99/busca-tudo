import { Client, LocalAuth } from 'whatsapp-web.js';
import type { Db } from './db';

export interface Transport {
  isReady(): boolean;
  sendToSelf(text: string): Promise<void>;
}

export class Notifier {
  private flushing = false;

  constructor(
    private db: Db,
    private transport: Transport,
    private now: () => Date = () => new Date(),
  ) {}

  /** Grava o alerta e tenta entregar; se não der, fica pendente para `flushPending`. */
  async send(trackerId: number, text: string, extra: { sourceUrl?: string; value?: number } = {}): Promise<void> {
    const id = this.db.addAlert({
      trackerId, at: this.now().toISOString(), text, sourceUrl: extra.sourceUrl, value: extra.value, delivered: false,
    });
    if (!this.transport.isReady()) return;
    try {
      await this.transport.sendToSelf(text);
      this.db.markDelivered(id);
    } catch {
      /* continua pendente */
    }
  }

  /** Texto avulso (ex.: resumo periódico): não vira alerta nem fica pendente. */
  async sendInfo(text: string): Promise<boolean> {
    if (!this.transport.isReady()) return false;
    try {
      await this.transport.sendToSelf(text);
      return true;
    } catch {
      return false;
    }
  }

  async flushPending(): Promise<number> {
    if (this.flushing || !this.transport.isReady()) return 0;
    this.flushing = true;
    let delivered = 0;
    try {
      for (const a of this.db.pendingAlerts()) {
        try {
          await this.transport.sendToSelf(a.text);
          this.db.markDelivered(a.id);
          delivered++;
        } catch {
          /* mantém pendente e segue */
        }
      }
    } finally {
      this.flushing = false;
    }
    return delivered;
  }
}

export type WhatsAppStatus = 'disconnected' | 'qr' | 'ready';

export function createWhatsAppTransport(
  authDir: string,
  onQr: (qr: string) => void,
  onStatus: (s: WhatsAppStatus) => void,
): Transport & { start(): Promise<void>; stop(): Promise<void> } {
  let ready = false;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authDir }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
  client.on('qr', (qr) => { ready = false; onQr(qr); onStatus('qr'); });
  client.on('ready', () => { ready = true; onStatus('ready'); });
  client.on('disconnected', () => { ready = false; onStatus('disconnected'); });
  client.on('auth_failure', () => { ready = false; onStatus('disconnected'); });

  return {
    isReady: () => ready,
    async sendToSelf(text: string) {
      const me = client.info?.wid?._serialized;
      if (!ready || !me) throw new Error('WhatsApp não está conectado.');
      await client.sendMessage(me, text);
    },
    async start() { await client.initialize(); },
    async stop() { ready = false; await client.destroy(); },
  };
}
