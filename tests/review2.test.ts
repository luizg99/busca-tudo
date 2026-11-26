import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { htmlToText, extractGenericPrice, snippetsAround } from '../src/service/html';
import { applyRule, learnSources } from '../src/service/sources';
import { fetchPage, isPrivateHost } from '../src/service/fetcher';
import { openDb } from '../src/service/db';
import type { FetchResult } from '../src/service/fetcher';
import type { Finding, NewTracker } from '../src/shared/types';

const nt: NewTracker = {
  name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'none',
};

describe('#4 entidades numéricas fora do intervalo não derrubam a leitura', () => {
  it('htmlToText mantém o texto e não lança com &#99999999; e &#x110000;', () => {
    const t = htmlToText('<p>Preço &#99999999; e &#x110000; ok &#8211; R$ 10,00 &#xD800;</p>');
    expect(t).toContain('R$ 10,00');
    expect(t).toContain('–');
  });
});

describe('#5 preço dividido em elementos de texto na mesma linha', () => {
  it('junta elementos inline sem espaço e separa blocos com espaço', () => {
    const t = htmlToText('<p><span>R$</span><span>1.299</span><span>,00</span></p><p>outro</p>');
    expect(t).toBe('R$1.299,00 outro');
    expect(snippetsAround(t, { radius: 10 })[0]).toContain('R$1.299,00');
  });
  it('tags de bloco e <br> continuam separando palavras', () => {
    expect(htmlToText('<div>a</div><div>b</div>linha<br>nova')).toBe('a b linha nova');
  });
});

describe('#6 leitor genérico usa o produto principal, não carrosséis de acessórios', () => {
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  it('com dois Products, vale o primeiro (principal), mesmo que o segundo seja mais barato', () => {
    const html = ld({ '@type': 'Product', name: 'PS5', offers: { price: 3000 } }) + ld({ '@type': 'Product', name: 'Capinha', offers: { price: 2100 } });
    expect(extractGenericPrice(html)).toBe(3000);
  });
  it('dentro do mesmo produto continua valendo o menor preço das ofertas', () => {
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: [{ price: 4100 }, { price: 3999.9 }] }))).toBe(3999.9);
  });
  it('meta/itemprop: vale o primeiro encontrado, não o menor da página', () => {
    const html = '<span itemprop="price" content="3000.00"></span><span itemprop="price" content="21.00"></span>';
    expect(extractGenericPrice(html)).toBe(3000);
  });
});

describe('#3 regex da IA não pode travar o serviço', () => {
  const text = 'a'.repeat(6000) + 'b';
  it('padrões com repetição aninhada são recusados na hora', () => {
    const t0 = Date.now();
    expect(applyRule({ type: 'regex', pattern: '(a+)+$' }, text)).toBeUndefined();
    expect(applyRule({ type: 'regex', pattern: '(.*\\s*)*R\\$\\s*([\\d.,]+)' }, text)).toBeUndefined();
    expect(applyRule({ type: 'regex', pattern: '(a|aa)+$' }, text)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('mesmo um padrão que escapa da heurística é interrompido pelo limite de tempo', () => {
    const t0 = Date.now();
    expect(applyRule({ type: 'regex', pattern: 'a*a*a*a*a*a*a*c' }, text)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('regra normal continua funcionando', () => {
    expect(applyRule({ type: 'regex', pattern: 'Por R\\$\\s*([\\d.,]+)' }, '<p>Por R$ 3524,00</p>')).toBe(3524);
  });
});

describe('#7 número dentro de outro número não vale como "preço presente"', () => {
  const f = (value: number): Finding => ({ found: true, value, currency: 'BRL', title: 'L', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9 });
  const learn = async (html: string, value: number) => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const fetchPage = async (): Promise<FetchResult> => ({ ok: true, html });
    await learnSources({ db, fetchPage }, t, [f(value)]);
    return db.listSources(t.id)[0];
  };
  it('299,00 não casa dentro de 1.299,00 nem de 2299,00', async () => {
    expect((await learn('<p>Por R$ 1.299,00</p>', 299)).status).toBe('unreadable');
    expect((await learn('<p>Por R$ 2299,00</p>', 299)).status).toBe('unreadable');
  });
  it('1.299,00 não casa dentro de 11.299,00, mas casa sozinho', async () => {
    expect((await learn('<p>R$ 11.299,00</p>', 1299)).status).toBe('unreadable');
    expect((await learn('<p>R$ 1.299,00</p>', 1299)).status).toBe('ok');
    expect((await learn('<p>R$ 299,00 à vista</p>', 299)).status).toBe('ok');
  });
});

describe('#8 busca que falhou não conta como descoberta feita', () => {
  it('lastDiscoveryAt ignora verificações com erro', () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    db.addCheck({ trackerId: t.id, at: '2026-01-01T10:00:00Z', ok: true, findings: [], model: 'm', costUsd: 0, mode: 'discovery' });
    db.addCheck({ trackerId: t.id, at: '2026-01-02T10:00:00Z', ok: false, error: 'x', findings: [], model: 'm', costUsd: 0, mode: 'discovery' });
    expect(db.lastDiscoveryAt(t.id)).toBe('2026-01-01T10:00:00Z');
  });
});

describe('#10 fetcher: acentos e endereços internos', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  async function serve(handler: (req: any, res: any) => void) {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const fp = (url: string, o: object = {}) => fetchPage(url, { allowedHosts: ['127.0.0.1'], ...o });

  it('respeita o charset do cabeçalho (ISO-8859-1)', async () => {
    const base = await serve((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }).end(Buffer.from('<p>preço à vista</p>', 'latin1')));
    expect(await fp(base)).toEqual({ ok: true, html: '<p>preço à vista</p>' });
  });
  it('respeita <meta charset> quando o cabeçalho não diz', async () => {
    const body = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>', 'ascii'), Buffer.from('preço', 'latin1'), Buffer.from('</p>', 'ascii')]);
    const base = await serve((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body));
    const r = await fp(base);
    expect(r.ok && r.html).toContain('preço');
  });
  it('UTF-8 continua funcionando', async () => {
    const base = await serve((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>preço</p>'));
    expect(await fp(base)).toEqual({ ok: true, html: '<p>preço</p>' });
  });

  it('isPrivateHost reconhece loopback, redes privadas e link-local, e deixa passar sites públicos', () => {
    for (const h of ['localhost', 'foo.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', 'fd00::1', 'fe80::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['www.ofertinha.com.br', '8.8.8.8', '172.32.0.1', '200.147.1.1']) expect(isPrivateHost(h), h).toBe(false);
  });
  it('recusa URL de endereço interno sem fazer a requisição', async () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1/admin', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data']) {
      const r = await fetchPage(u);
      expect(r, u).toMatchObject({ ok: false, kind: 'invalid' });
      expect((r as any).message).toMatch(/interno/i);
    }
  });
  it('redirecionamento para endereço interno também é recusado', async () => {
    const base = await serve((_req, res) => res.writeHead(302, { location: 'http://10.0.0.5/segredo' }).end());
    const r = await fp(base);
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('redirecionamento normal entre páginas permitidas continua funcionando e há limite de saltos', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a') res.writeHead(302, { location: '/b' }).end();
      else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end();
      else res.writeHead(200).end('fim');
    });
    expect(await fp(base + '/a')).toEqual({ ok: true, html: 'fim' });
    expect(await fp(base + '/loop')).toMatchObject({ ok: false });
  });
});
