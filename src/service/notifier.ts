import { rmSync } from 'node:fs';
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

/** JID do próprio número a partir de `sock.user.id` (ex.: "5511999990000:12@s.whatsapp.net" ou "1234:5@lid"). */
export function selfJid(userId: string | undefined): string {
  const [user, server] = (userId ?? '').split('@');
  const number = user.split(':')[0].replace(/\D/g, '');
  if (!number) throw new Error('Número do WhatsApp conectado indisponível.');
  return `${number}@${server === 'lid' ? 'lid' : 's.whatsapp.net'}`;
}

/** Atraso antes de reconectar: logo na 1ª queda (o WhatsApp derruba o socket com 515 logo após parear o QR), depois cresce com teto. */
export function reconnectDelayMs(attempt: number): number {
  return attempt <= 0 ? 2_000 : nextBackoffMs(attempt - 1);
}

/** Parte da API do Baileys que o transporte usa (permite injetar um falso nos testes). */
export interface BaileysLike {
  default(opts: any): any;
  useMultiFileAuthState(dir: string): Promise<{ state: any; saveCreds: () => Promise<void> }>;
  fetchLatestBaileysVersion(): Promise<{ version: [number, number, number] }>;
  DisconnectReason: { loggedOut: number; connectionReplaced: number; restartRequired: number };
}
export interface TransportDeps {
  loadBaileys: () => Promise<BaileysLike>;
  makeLogger: () => Promise<any>;
  removeDir: (path: string) => void;
}
const defaultDeps: TransportDeps = {
  loadBaileys: async () => (await import('@whiskeysockets/baileys')) as unknown as BaileysLike,
  makeLogger: async () => (await import('pino')).default({ level: 'silent' }),
  removeDir: (p) => rmSync(p, { recursive: true, force: true }),
};

/**
 * Transporte WhatsApp via Baileys (protocolo direto, sem navegador). As credenciais ficam em `authDir`
 * (multi-file auth), então o QR só é pedido na primeira vez ou depois de sair do aparelho no celular.
 * O pacote é ESM, por isso é carregado com import() dinâmico.
 */
export function createWhatsAppTransport(
  authDir: string,
  onQr: (qr: string) => void,
  onStatus: (s: WhatsAppStatus) => void,
  log: (msg: string) => void = () => undefined,
  overrides: Partial<TransportDeps> = {},
): Transport & { start(): Promise<void>; stop(): Promise<void> } {
  const deps = { ...defaultDeps, ...overrides };
  let sock: any;
  let ready = false;
  let stopped = false;
  let connecting = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let protocolVersion: [number, number, number] | undefined;
  /** Sobe a cada stop(): um connect() iniciado antes não pode criar socket depois dele. */
  let generation = 0;

  function scheduleReconnect(reason: string): void {
    if (stopped || retryTimer) return;
    const wait = reconnectDelayMs(attempt++);
    log(`whatsapp: ${reason}; reconectando em ${Math.round(wait / 1000)}s`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, wait);
  }

  async function connect(): Promise<void> {
    if (stopped || connecting) return;
    connecting = true;
    const myGeneration = generation;
    try {
      const baileys = await deps.loadBaileys();
      const logger = await deps.makeLogger();
      const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
      // A versão do protocolo embutida no pacote envelhece e o WhatsApp passa a recusar o handshake (405);
      // busca a atual uma vez e, se falhar, usa a embutida.
      if (!protocolVersion) {
        protocolVersion = await baileys.fetchLatestBaileysVersion().then((r) => r.version).catch((e) => {
          log(`whatsapp: não consegui buscar a versão do protocolo (${e}); usando a embutida`);
          return undefined;
        });
      }
      // stop() pode ter sido chamado enquanto esperávamos a rede: não cria socket que ninguém vai fechar
      if (stopped || generation !== myGeneration) return;
      const s = baileys.default({
        ...(protocolVersion ? { version: protocolVersion } : {}),
        auth: state,
        logger,
      });
      sock = s;
      // Gravações de credenciais em fila única: no logout dá para esperar a última terminar antes de apagar a pasta.
      let pendingSave: Promise<unknown> = Promise.resolve();
      let loggedOut = false;
      s.ev.on('creds.update', () => {
        if (loggedOut) return;
        pendingSave = pendingSave.then(() => saveCreds()).catch((e) => log(`whatsapp: falha ao gravar credenciais (${e})`));
      });
      s.ev.on('connection.update', (u: any) => {
        if (sock !== s) return; // evento de um socket antigo
        if (u.qr) { ready = false; onQr(u.qr); onStatus('qr'); }
        if (u.connection === 'open') { ready = true; attempt = 0; onStatus('ready'); }
        if (u.connection === 'close') {
          ready = false;
          sock = undefined;
          const code = u.lastDisconnect?.error?.output?.statusCode;
          const reasons = baileys.DisconnectReason;
          if (code === reasons.restartRequired) {
            // reinício esperado logo após parear o QR: reconecta sem mostrar "desconectado"
            scheduleReconnect('reinício necessário após o pareamento');
            return;
          }
          onStatus('disconnected');
          if (code === reasons.connectionReplaced) {
            // outra cópia está usando a mesma sessão: reconectar só faria as duas brigarem em loop
            log('whatsapp: sessão substituída por outra conexão; não vou reconectar sozinho (reinicie o serviço)');
          } else if (code === reasons.loggedOut) {
            // saiu do aparelho no celular: credenciais inválidas; apaga (depois da gravação pendente) e pede novo QR
            loggedOut = true;
            attempt = 0;
            void pendingSave.then(() => {
              deps.removeDir(authDir);
              scheduleReconnect('sessão encerrada no celular, novo QR necessário');
            });
          } else {
            scheduleReconnect(`caiu (${code ?? 'sem código'})`);
          }
        }
      });
    } catch (e) {
      sock = undefined;
      onStatus('disconnected');
      scheduleReconnect(`falha ao iniciar (${(e as Error).message})`);
    } finally {
      connecting = false;
    }
  }

  return {
    isReady: () => ready,
    async sendToSelf(text: string) {
      if (!ready || !sock) throw new Error('WhatsApp não está conectado.');
      const current = sock;
      try {
        await current.sendMessage(selfJid(current.user?.id), { text });
      } catch (e) {
        // socket provavelmente morto: marca como não pronto e derruba para reconectar (o Notifier mantém o alerta pendente)
        ready = false;
        try { current.end(e instanceof Error ? e : undefined); } catch { /* já fechado */ }
        throw e;
      }
    },
    async start() { stopped = false; attempt = 0; await connect(); },
    async stop() {
      stopped = true;
      generation++;
      ready = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      try { sock?.end(undefined); } catch { /* já fechado */ }
      sock = undefined;
    },
  };
}
