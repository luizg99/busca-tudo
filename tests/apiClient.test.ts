import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiClient, ApiError, isServiceUp } from '../src/app/apiClient';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function fake(handler: (req: any, res: any) => void) {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('apiClient', () => {
  it('envia Authorization: Bearer e devolve o JSON', async () => {
    let auth = '';
    const base = await fake((req, res) => { auth = req.headers.authorization; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
    const c = createApiClient(base, 'abc');
    expect(await c.get('/status')).toEqual({ ok: true });
    expect(auth).toBe('Bearer abc');
  });

  it('post envia o corpo como JSON', async () => {
    let body = '';
    const base = await fake((req, res) => { req.on('data', (d: Buffer) => (body += d)); req.on('end', () => res.writeHead(200).end('{}')); });
    await createApiClient(base, 't').post('/x', { a: 1 });
    expect(JSON.parse(body)).toEqual({ a: 1 });
  });

  it('resposta 4xx vira ApiError com a mensagem do corpo', async () => {
    const base = await fake((_req, res) => res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"O intervalo mínimo é de 15 minutos."}'));
    const err = await createApiClient(base, 't').post('/trackers', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('15');
  });

  it('204 devolve undefined em del', async () => {
    const base = await fake((_req, res) => res.writeHead(204).end());
    expect(await createApiClient(base, 't').del('/trackers/1')).toBeUndefined();
  });

  it('isServiceUp é falso quando a conexão é recusada (sem lançar) e verdadeiro quando responde', async () => {
    expect(await isServiceUp(createApiClient('http://127.0.0.1:1', 't'))).toBe(false);
    const base = await fake((_req, res) => res.writeHead(200).end('{"running":true}'));
    expect(await isServiceUp(createApiClient(base, 't'))).toBe(true);
  });
});
