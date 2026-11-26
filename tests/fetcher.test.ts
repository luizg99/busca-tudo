import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPage } from '../src/service/fetcher';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function serve(handler: (req: any, res: any) => void) {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('fetchPage', () => {
  it('200: devolve o HTML e envia um User-Agent de navegador', async () => {
    let ua = '';
    const base = await serve((req, res) => { ua = req.headers['user-agent']; res.writeHead(200, { 'content-type': 'text/html' }).end('<p>R$ 10,00</p>'); });
    const r = await fetchPage(base + '/p');
    expect(r).toEqual({ ok: true, html: '<p>R$ 10,00</p>' });
    expect(ua).toMatch(/Mozilla/);
  });

  it('segue redirecionamento', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a') res.writeHead(302, { location: '/b' }).end();
      else res.writeHead(200).end('destino');
    });
    expect(await fetchPage(base + '/a')).toEqual({ ok: true, html: 'destino' });
  });

  it('403 e 429 viram "bloqueado" com mensagem clara', async () => {
    const base = await serve((_req, res) => res.writeHead(429).end('slow down'));
    const r = await fetchPage(base);
    expect(r).toMatchObject({ ok: false, kind: 'blocked', status: 429 });
    expect((r as any).message).toMatch(/bloque/i);
  });

  it('404/500 viram erro http com o código', async () => {
    const base = await serve((_req, res) => res.writeHead(404).end());
    const r = await fetchPage(base);
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 404 });
    expect((r as any).message).toContain('404');
  });

  it('página lenta estoura o timeout', async () => {
    const base = await serve(() => { /* nunca responde */ });
    const r = await fetchPage(base, { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('conexão recusada vira erro de rede', async () => {
    const r = await fetchPage('http://127.0.0.1:1/', { timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });

  it('corpo maior que o limite é cortado (não estoura memória)', async () => {
    const base = await serve((_req, res) => res.writeHead(200).end('x'.repeat(5000)));
    const r = await fetchPage(base, { maxBytes: 1000 });
    expect(r.ok).toBe(true);
    expect((r as any).html.length).toBeLessThanOrEqual(1000);
  });

  it('URL que não é http(s) é recusada', async () => {
    expect(await fetchPage('file:///etc/passwd')).toMatchObject({ ok: false, kind: 'invalid' });
  });
});
