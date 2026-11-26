import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { htmlToText, extractGenericPrice } from '../src/service/html';
import { applyRule } from '../src/service/sources';
import { fetchPage, isPrivateHost } from '../src/service/fetcher';
import { openDb } from '../src/service/db';
import type { NewTracker } from '../src/shared/types';

const nt: NewTracker = {
  name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'none',
};

describe('#4 texto de elementos vizinhos não gruda, exceto pedaços de um mesmo preço', () => {
  it('preço seguido de "12x de ..." fica separado', () => {
    const t = htmlToText('<span>R$ 3.524,00</span><span>12x de 293,67</span>');
    expect(t).toBe('R$ 3.524,00 12x de 293,67');
    expect(applyRule({ type: 'regex', pattern: 'R\\$\\s*([\\d.,]+)' }, '<span>R$ 3.524,00</span><span>12x de 293,67</span>')).toBe(3524);
  });
  it('links vizinhos continuam sendo palavras separadas', () => {
    expect(htmlToText('<a>Home</a><a>Produtos</a>')).toBe('Home Produtos');
  });
  it('pedaços de um mesmo preço continuam sendo juntados', () => {
    expect(htmlToText('<span>R$</span><span>1.299</span><span>,00</span>')).toBe('R$1.299,00');
    expect(htmlToText('<span>R$ 1.299</span><span>,00</span>')).toBe('R$ 1.299,00');
    expect(htmlToText('<b>R$ 3</b><b>.524</b><b>,00</b>')).toBe('R$ 3.524,00');
  });
});

describe('#6 filtro de regex: menos falso positivo, mais cobertura', () => {
  const T = '<p>Por R$ 123 no pix</p>';
  it('repetição limitada {1,3} é aceita (não é catastrófica)', () => {
    expect(applyRule({ type: 'regex', pattern: 'R\\$\\s*(\\d+){1,3}' }, T)).toBe(123);
  });
  it('grupos aninhados, com ou sem (?:), repetidos sem limite são recusados', () => {
    const big = 'a'.repeat(5000) + 'b';
    const t0 = Date.now();
    for (const p of ['((\\d+))+x', '(?:a+)+$', '(a+|b)+$', '((a|aa))+$', '(\\d+)*x']) {
      expect(applyRule({ type: 'regex', pattern: p }, big), p).toBeUndefined();
    }
    expect(Date.now() - t0).toBeLessThan(800);
  });
  it('regras comuns com grupo de captura e \\s* continuam funcionando', () => {
    expect(applyRule({ type: 'regex', pattern: 'Por R\\$\\s*([\\d.,]+)\\s*no pix' }, T.replace('123', '3524,00'))).toBe(3524);
  });
  it('várias chamadas seguidas funcionam (contexto reaproveitado) e uma regra lenta não contamina a próxima', () => {
    const big = 'a'.repeat(6000) + 'b';
    expect(applyRule({ type: 'regex', pattern: 'a*a*a*a*a*a*a*c' }, big)).toBeUndefined(); // estoura o limite de tempo
    expect(applyRule({ type: 'regex', pattern: 'Por R\\$\\s*([\\d.,]+)' }, '<p>Por R$ 10,00</p>')).toBe(10);
  });
});

describe('#7 leitor genérico prefere o produto principal', () => {
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  it('uma lista de produtos relacionados antes do Product não vence', () => {
    const html = ld({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'Product', name: 'Controle', offers: { price: 350 } } }] })
      + ld({ '@type': 'Product', name: 'PS5', offers: { price: 3000 } });
    expect(extractGenericPrice(html)).toBe(3000);
  });
  it('sem nenhum Product, usa o primeiro grupo de ofertas', () => {
    expect(extractGenericPrice(ld({ '@type': 'Thing', offers: { price: 10 } }))).toBe(10);
  });
});

describe('#1 banco: tentativa de busca separada da busca bem-sucedida', () => {
  it('lastDiscoveryAttempt devolve a última tentativa (com ok), mesmo que tenha falhado', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    expect(db.lastDiscoveryAttempt(t.id)).toBeUndefined();
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'discovery' });
    db.addCheck({ trackerId: t.id, at: '2026-01-01T11:00:00Z', ok: false, error: 'x', findings: [], model: 'm', costUsd: 0, mode: 'fallback' });
    db.addCheck({ trackerId: t.id, at: '2026-01-01T12:00:00Z', ok: false, error: 'y', findings: [], model: 'm', costUsd: 0, mode: 'routine' });
    expect(db.lastDiscoveryAttempt(t.id)).toEqual({ at: '2026-01-01T11:00:00Z', ok: false });
    expect(db.lastDiscoveryAt(t.id)).toBe('2026-01-01T10:00:00Z');
  });
});

describe('#2 IPv6 mapeado e faixas especiais', () => {
  it('bloqueia ::ffff:a.b.c.d em hexadecimal e decimal, e as faixas CGNAT/benchmark/IETF', () => {
    for (const h of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1', '::ffff:a00:1', '100.64.0.1', '100.127.255.1', '198.18.0.1', '198.19.1.1', '192.0.0.1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['::ffff:808:808', '100.128.0.1', '100.63.0.1', '198.20.0.1', '192.0.1.1', '2606:4700::1111']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
  it('fetchPage recusa a URL com IPv6 mapeado', async () => {
    expect(await fetchPage('http://[::ffff:7f00:1]:3000/')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await fetchPage('http://[::ffff:169.254.169.254]/latest/meta-data')).toMatchObject({ ok: false, kind: 'invalid' });
  });
});

describe('#3 DNS validado e usado na conexão (sem janela para rebinding)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  async function serve(handler: (req: any, res: any) => void) {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server!.address() as AddressInfo).port;
  }

  it('nome que resolve para IP interno é recusado', async () => {
    const r = await fetchPage('http://rebind.test:80/', { resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
    expect((r as any).message).toMatch(/interno/i);
  });
  it('se qualquer um dos IPs resolvidos for interno, recusa (resposta mista)', async () => {
    const r = await fetchPage('http://mixed.test/', { resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }] });
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('falha de DNS não segue adiante: vira erro de rede', async () => {
    const r = await fetchPage('http://naoexiste.test/', { resolver: async () => { throw new Error('ENOTFOUND'); } });
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });
  it('a conexão usa o IP que o resolvedor validou (o nome nem precisa existir no DNS real)', async () => {
    const port = await serve((_req, res) => res.writeHead(200).end('<p>ok</p>'));
    const r = await fetchPage(`http://good.test:${port}/`, { allowedHosts: ['127.0.0.1'], resolver: async () => [{ address: '127.0.0.1', family: 4 }], allowResolvedHosts: ['127.0.0.1'] });
    expect(r).toEqual({ ok: true, html: '<p>ok</p>' });
  });

  const fp = (url: string, o: object = {}) => fetchPage(url, { allowedHosts: ['127.0.0.1'], ...o });
  it('URL malformada é "inválida", não erro de conexão', async () => {
    expect(await fetchPage('http://')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await fetchPage('http://exemplo com espaço/')).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('vários redirecionamentos seguidos funcionam sem pendurar (corpo do 3xx é descartado)', async () => {
    const port = await serve((req, res) => {
      const n = Number(req.url.slice(1) || 0);
      if (n < 4) res.writeHead(302, { location: `/${n + 1}` }).end('x'.repeat(100000));
      else res.writeHead(200).end('fim');
    });
    expect(await fp(`http://127.0.0.1:${port}/0`)).toEqual({ ok: true, html: 'fim' });
  });
  it('decodifica resposta gzip', async () => {
    const port = await serve((_req, res) => res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' }).end(gzipSync('<p>preço</p>')));
    expect(await fp(`http://127.0.0.1:${port}/`)).toEqual({ ok: true, html: '<p>preço</p>' });
  });
});
