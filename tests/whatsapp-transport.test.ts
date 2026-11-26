import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWhatsAppTransport, selfJid } from '../src/service/notifier';

type Handler = (p: any) => void;

function fakeBaileys(opts: { gate?: Promise<void>; slowSave?: Promise<void> } = {}) {
  const sockets: any[] = [];
  const saveCreds = vi.fn(async () => { if (opts.slowSave) await opts.slowSave; });
  const mk = () => {
    const handlers: Record<string, Handler[]> = {};
    const s: any = {
      ev: { on: (e: string, h: Handler) => { (handlers[e] ??= []).push(h); } },
      emit: (e: string, p?: any) => handlers[e]?.forEach((h) => h(p)),
      user: { id: '5511999990000:1@s.whatsapp.net' },
      sendMessage: vi.fn(async () => undefined),
      end: vi.fn(),
    };
    sockets.push(s);
    return s;
  };
  const baileys = {
    default: mk,
    useMultiFileAuthState: async () => { if (opts.gate) await opts.gate; return { state: {}, saveCreds }; },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] as [number, number, number] }),
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515, badSession: 500, multideviceMismatch: 411 },
  };
  return { baileys, sockets, saveCreds };
}

const closeWith = (code?: number) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });

function setup(opts: Parameters<typeof fakeBaileys>[0] = {}) {
  const fb = fakeBaileys(opts);
  const statuses: string[] = [];
  const removed: string[] = [];
  const t = createWhatsAppTransport('/auth', () => undefined, (s) => statuses.push(s), () => undefined, {
    loadBaileys: async () => fb.baileys as any,
    makeLogger: async () => ({}),
    removeDir: (p: string) => { removed.push(p); },
  });
  return { ...fb, t, statuses, removed };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('transporte WhatsApp (Baileys falso)', () => {
  it('conecta, fica pronto no open e envia para o próprio número', async () => {
    const { t, sockets } = setup();
    await t.start();
    sockets[0].emit('connection.update', { connection: 'open' });
    expect(t.isReady()).toBe(true);
    await t.sendToSelf('oi');
    expect(sockets[0].sendMessage).toHaveBeenCalledWith('5511999990000@s.whatsapp.net', { text: 'oi' });
  });

  it('stop() seguido de start() não trava as reconexões (timer antigo zerado)', async () => {
    const { t, sockets } = setup();
    await t.start();
    sockets[0].emit('connection.update', closeWith(undefined)); // agenda retry
    await t.stop();
    await t.start();
    expect(sockets).toHaveLength(2);
    sockets[1].emit('connection.update', closeWith(undefined));
    await vi.advanceTimersByTimeAsync(2100);
    expect(sockets).toHaveLength(3);
  });

  it('stop() durante o connect() não deixa um socket vivo para trás', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { t, sockets } = setup({ gate });
    const starting = t.start();
    await t.stop();
    release();
    await starting;
    expect(sockets).toHaveLength(0);
  });

  it('connectionReplaced (440) não reconecta em loop', async () => {
    const { t, sockets, statuses } = setup();
    await t.start();
    sockets[0].emit('connection.update', closeWith(440));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toContain('disconnected');
  });

  it('logout: espera a gravação pendente das credenciais antes de apagar a pasta, não grava depois, e volta a pedir QR', async () => {
    let release!: () => void;
    const slowSave = new Promise<void>((r) => (release = r));
    const { t, sockets, saveCreds, removed } = setup({ slowSave });
    await t.start();
    sockets[0].emit('creds.update');
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCreds).toHaveBeenCalledTimes(1);
    sockets[0].emit('connection.update', closeWith(401));
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).toEqual([]); // gravação ainda em andamento
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).toEqual(['/auth']);
    sockets[0].emit('creds.update'); // depois do logout não grava de novo
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCreds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(sockets).toHaveLength(2);
  });

  it('515 (reinício esperado após o QR) reconecta sem piscar "desconectado"', async () => {
    const { t, sockets, statuses } = setup();
    await t.start();
    sockets[0].emit('connection.update', closeWith(515));
    expect(statuses).not.toContain('disconnected');
    await vi.advanceTimersByTimeAsync(2100);
    expect(sockets).toHaveLength(2);
  });

  it('queda comum informa "desconectado" e reconecta', async () => {
    const { t, sockets, statuses } = setup();
    await t.start();
    sockets[0].emit('connection.update', closeWith(428));
    expect(statuses).toContain('disconnected');
    await vi.advanceTimersByTimeAsync(2100);
    expect(sockets).toHaveLength(2);
  });

  it('falha no envio marca como não pronto, derruba o socket para reconectar e propaga o erro', async () => {
    const { t, sockets } = setup();
    await t.start();
    sockets[0].emit('connection.update', { connection: 'open' });
    sockets[0].sendMessage.mockRejectedValueOnce(new Error('Connection Closed'));
    await expect(t.sendToSelf('x')).rejects.toThrow('Connection Closed');
    expect(t.isReady()).toBe(false);
    expect(sockets[0].end).toHaveBeenCalled();
  });
});

describe('selfJid com identificador LID', () => {
  it('mantém o servidor "lid" em vez de forçar @s.whatsapp.net', () => {
    expect(selfJid('1234567890:5@lid')).toBe('1234567890@lid');
  });
  it('sem servidor ou com s.whatsapp.net continua montando @s.whatsapp.net', () => {
    expect(selfJid('5511999990000:12@s.whatsapp.net')).toBe('5511999990000@s.whatsapp.net');
    expect(selfJid('5511999990000')).toBe('5511999990000@s.whatsapp.net');
  });
});
