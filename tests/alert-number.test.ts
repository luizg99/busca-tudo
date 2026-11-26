import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePhone } from '../src/service/phone';
import { Notifier, createWhatsAppTransport, type Transport } from '../src/service/notifier';
import { openDb } from '../src/service/db';

describe('normalizePhone', () => {
  it('aceita formatos comuns e devolve só dígitos com DDI 55', () => {
    expect(normalizePhone('(11) 99999-0000')).toBe('5511999990000');
    expect(normalizePhone('11 99999-0000')).toBe('5511999990000');
    expect(normalizePhone('+55 11 99999-0000')).toBe('5511999990000');
    expect(normalizePhone('5511999990000')).toBe('5511999990000');
    expect(normalizePhone('1199990000')).toBe('551199990000'); // fixo/antigo: 10 dígitos
  });
  it('recusa vazio, texto e números curtos ou longos demais', () => {
    expect(normalizePhone('')).toBeUndefined();
    expect(normalizePhone('   ')).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
    expect(normalizePhone('123')).toBeUndefined();
    expect(normalizePhone('1234567890123456')).toBeUndefined();
  });
});

describe('Notifier com número de destino', () => {
  function setup(target?: string) {
    const db = openDb(':memory:');
    const t = db.createTracker({
      name: 'x', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
      alertCondition: { type: 'below_last' }, digest: 'none',
    });
    const calls: Array<{ to: string; text: string }> = [];
    const transport: Transport = {
      isReady: () => true,
      async sendToSelf(text) { calls.push({ to: 'self', text }); },
      async sendTo(number, text) { calls.push({ to: number, text }); },
    };
    let current = target;
    const notifier = new Notifier(db, transport, () => new Date(), { getTarget: () => current });
    return { notifier, t, calls, setTarget: (v?: string) => { current = v; } };
  }

  it('sem destino configurado envia para o próprio número', async () => {
    const { notifier, t, calls } = setup();
    await notifier.send(t.id, 'oi');
    expect(calls).toEqual([{ to: 'self', text: 'oi' }]);
  });
  it('com destino configurado envia para ele (alertas, pendentes e mensagens avulsas)', async () => {
    const { notifier, t, calls } = setup('5511999990000');
    await notifier.send(t.id, 'alerta');
    await notifier.sendInfo('resumo');
    expect(calls).toEqual([{ to: '5511999990000', text: 'alerta' }, { to: '5511999990000', text: 'resumo' }]);
  });
  it('o destino é lido a cada envio (trocar nas configurações vale na hora)', async () => {
    const { notifier, t, calls, setTarget } = setup();
    await notifier.send(t.id, 'a');
    setTarget('5521988887777');
    await notifier.send(t.id, 'b');
    expect(calls.map((c) => c.to)).toEqual(['self', '5521988887777']);
  });
});

describe('transporte Baileys: sendTo', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function build(onWhatsApp: (n: string) => Promise<any>) {
    const sockets: any[] = [];
    const baileys = {
      default: () => {
        const handlers: Record<string, Array<(p: any) => void>> = {};
        const s: any = {
          ev: { on: (e: string, h: (p: any) => void) => { (handlers[e] ??= []).push(h); } },
          emit: (e: string, p?: any) => handlers[e]?.forEach((h) => h(p)),
          user: { id: '5511111111111:1@s.whatsapp.net' },
          sendMessage: vi.fn(async () => undefined),
          onWhatsApp: vi.fn(onWhatsApp),
          end: vi.fn(),
        };
        sockets.push(s);
        return s;
      },
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] as [number, number, number] }),
      DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515 },
    };
    const t = createWhatsAppTransport('/auth', () => undefined, () => undefined, () => undefined, {
      loadBaileys: async () => baileys as any, makeLogger: async () => ({}), removeDir: () => undefined,
    });
    return { t, sockets };
  }

  it('usa o JID real devolvido pelo WhatsApp (corrige o nono dígito)', async () => {
    const { t, sockets } = build(async () => [{ exists: true, jid: '551199990000@s.whatsapp.net' }]);
    await t.start();
    sockets[0].emit('connection.update', { connection: 'open' });
    await t.sendTo!('5511999990000', 'oi');
    expect(sockets[0].sendMessage).toHaveBeenCalledWith('551199990000@s.whatsapp.net', { text: 'oi' });
  });

  it('número que não existe no WhatsApp dá erro claro e não envia', async () => {
    const { t, sockets } = build(async () => [{ exists: false, jid: 'x@s.whatsapp.net' }]);
    await t.start();
    sockets[0].emit('connection.update', { connection: 'open' });
    await expect(t.sendTo!('5511999990000', 'oi')).rejects.toThrow(/não está registrado no WhatsApp/);
    expect(sockets[0].sendMessage).not.toHaveBeenCalled();
    expect(t.isReady()).toBe(true); // erro de destino não derruba a conexão
  });

  it('se a consulta falhar por rede, tenta o JID direto', async () => {
    const { t, sockets } = build(async () => { throw new Error('timeout'); });
    await t.start();
    sockets[0].emit('connection.update', { connection: 'open' });
    await t.sendTo!('5511999990000', 'oi');
    expect(sockets[0].sendMessage).toHaveBeenCalledWith('5511999990000@s.whatsapp.net', { text: 'oi' });
  });
});
