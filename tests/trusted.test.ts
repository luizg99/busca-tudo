import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_TRUSTED_SITES, normalizeDomain, normalizeTrustedList, isTrustedUrl, classifyFinding, getTrustedSites } from '../src/service/trust';
import { resolveFinalUrl } from '../src/service/fetcher';
import { runSmartCheck } from '../src/service/checker';
import { decideAlert, isReliablePrice } from '../src/service/decide';
import { runCheck } from '../src/service/pipeline';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker, Tracker } from '../src/shared/types';

const T = ['amazon.com.br', 'mercadolivre.com.br', 'kabum.com.br'];
const ld = (price: number) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'PS5', offers: { '@type': 'Offer', price: String(price), priceCurrency: 'BRL', availability: 'https://schema.org/InStock' } })}</script></head><body>PS5</body></html>`;
const f = (over: Partial<Finding> = {}): Finding => ({ found: true, value: 3524, currency: 'BRL', title: 'x', sourceUrl: 'https://www.ofertinha.com.br/ps5', evidence: 'e', confidence: 0.9, ...over });

describe('normalizeDomain / isTrustedUrl', () => {
  it('extrai o domínio de URL ou texto, sem www, em minúsculas', () => {
    expect(normalizeDomain('https://WWW.Amazon.com.br/dp/X?tag=1')).toBe('amazon.com.br');
    expect(normalizeDomain('www.kabum.com.br')).toBe('kabum.com.br');
    expect(normalizeDomain('  MercadoLivre.com.br/ ')).toBe('mercadolivre.com.br');
    expect(normalizeDomain('')).toBeUndefined();
    expect(normalizeDomain('não é um domínio')).toBeUndefined();
  });
  it('subdomínios contam; sufixos enganosos não', () => {
    expect(isTrustedUrl('https://smile.amazon.com.br/dp/x', T)).toBe(true);
    expect(isTrustedUrl('https://amazon.com.br/', T)).toBe(true);
    expect(isTrustedUrl('https://evilamazon.com.br/', T)).toBe(false);
    expect(isTrustedUrl('https://amazon.com.br.golpe.com/', T)).toBe(false);
    expect(isTrustedUrl('https://www.ofertinha.com.br/', T)).toBe(false);
    expect(isTrustedUrl('não é url', T)).toBe(false);
  });
  it('normalizeTrustedList limpa, tira duplicados e descarta lixo', () => {
    expect(normalizeTrustedList(['https://www.Amazon.com.br/', 'amazon.com.br', 'kabum.com.br ', '', 'lixo lixo', 42 as any])).toEqual(['amazon.com.br', 'kabum.com.br']);
  });
  it('lista padrão contém as grandes lojas e getTrustedSites usa o padrão quando nada foi configurado', () => {
    for (const d of ['amazon.com.br', 'mercadolivre.com.br', 'magazineluiza.com.br', 'kabum.com.br', 'americanas.com.br', 'casasbahia.com.br', 'fastshop.com.br', 'pichau.com.br', 'terabyteshop.com.br']) {
      expect(DEFAULT_TRUSTED_SITES).toContain(d);
    }
    const db = openDb(':memory:');
    expect(getTrustedSites(db)).toEqual(DEFAULT_TRUSTED_SITES);
    db.setSetting('trusted_sites', JSON.stringify(['kabum.com.br']));
    expect(getTrustedSites(db)).toEqual(['kabum.com.br']);
  });
});

describe('classifyFinding: vale a loja que vende, não o site onde a oferta foi vista', () => {
  const never = async () => { throw new Error('não deveria seguir link'); };
  it('oferta numa página de loja confiável vale', async () => {
    expect(await classifyFinding(f({ sourceUrl: 'https://www.amazon.com.br/dp/PS5' }), T, never)).toEqual({ verdict: 'trusted' });
  });
  it('site desconhecido com link direto para a loja confiável vale (via), sem precisar seguir redirecionamento', async () => {
    const r = await classifyFinding(f({ store: 'Amazon', storeUrl: 'https://www.amazon.com.br/dp/PS5?tag=a' }), T, never);
    expect(r).toMatchObject({ verdict: 'via_trusted', via: 'ofertinha.com.br' });
  });
  it('site desconhecido com link de saída (afiliado) que termina em loja confiável vale', async () => {
    const r = await classifyFinding(f({ storeUrl: 'https://www.ofertinha.com.br/go/ps5' }), T, async () => ({ ok: true, finalUrl: 'https://www.amazon.com.br/dp/PS5?tag=x' }));
    expect(r).toMatchObject({ verdict: 'via_trusted', via: 'ofertinha.com.br' });
  });
  it('link de saída que termina em loja desconhecida é ignorado com o motivo', async () => {
    const r = await classifyFinding(f({ storeUrl: 'https://www.ofertinha.com.br/go/ps5' }), T, async () => ({ ok: true, finalUrl: 'https://www.lojadesconhecida.com/x' }));
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as any).reason).toMatch(/não leva a uma loja confiável/i);
  });
  it('sem link da loja (só o nome no texto) não basta: ignorado', async () => {
    const r = await classifyFinding(f({ store: 'Amazon' }), T, never);
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as any).reason).toMatch(/sem link/i);
  });
  it('falha ao seguir o link é ignorada com o motivo (não aceita no escuro)', async () => {
    const r = await classifyFinding(f({ storeUrl: 'https://www.ofertinha.com.br/go/ps5' }), T, async () => ({ ok: false, message: 'O site demorou' }));
    expect(r).toMatchObject({ verdict: 'ignored' });
    expect((r as any).reason).toContain('demorou');
  });
  it('achado sem URL de origem também é ignorado', async () => {
    expect(await classifyFinding(f({ sourceUrl: undefined }), T, never)).toMatchObject({ verdict: 'ignored' });
  });
});

describe('resolveFinalUrl segue redirecionamentos pelo baixador seguro', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  it('devolve a URL final depois de vários saltos', async () => {
    server = createServer((req, res) => {
      if (req.url === '/a') res.writeHead(302, { location: '/b' }).end();
      else if (req.url === '/b') res.writeHead(301, { location: '/c?x=1' }).end();
      else res.writeHead(200).end('fim');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const r = await resolveFinalUrl(`http://127.0.0.1:${port}/a`, { allowedHosts: ['127.0.0.1'] });
    expect(r).toEqual({ ok: true, finalUrl: `http://127.0.0.1:${port}/c?x=1` });
  });
  it('recusa endereço interno e informa falha de rede', async () => {
    expect(await resolveFinalUrl('http://169.254.169.254/x')).toMatchObject({ ok: false });
    expect(await resolveFinalUrl('http://127.0.0.1:1/', { allowedHosts: ['127.0.0.1'], timeoutMs: 1500 })).toMatchObject({ ok: false });
  });
});

describe('busca: o prompt pede loja, link da loja e cupom, e menciona a lista confiável', () => {
  const tracker: Tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '2026-01-01T00:00:00Z', onlyTrusted: true };
  const models = { routine: 'm', escalate: 'm2' };
  const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
  it('inclui as lojas confiáveis no prompt e mantém store, store_url e coupon', async () => {
    const calls: Array<{ system: string; prompt: string }> = [];
    const llm: LlmClient = {
      async search(req) {
        calls.push(req);
        return { text: JSON.stringify({ findings: [{ found: true, value: 3524, currency: 'BRL', source_url: 'https://www.ofertinha.com.br/x', store: 'Amazon', store_url: 'https://www.ofertinha.com.br/go/x', coupon: 'PROMOAGORA (Pix)', evidence: 'e', confidence: 0.9 }] }), usage };
      },
      async chat() { throw new Error('x'); },
    };
    const out = await runSmartCheck(llm, tracker, models, { trustedSites: ['amazon.com.br', 'kabum.com.br'] });
    const text = calls[0].system + '\n' + calls[0].prompt;
    expect(text).toContain('amazon.com.br');
    expect(text).toContain('kabum.com.br');
    expect(text).toMatch(/store_url/);
    expect(text).toMatch(/coupon/);
    expect(text).toMatch(/cupom/i);
    expect(out.findings[0]).toMatchObject({ store: 'Amazon', storeUrl: 'https://www.ofertinha.com.br/go/x', coupon: 'PROMOAGORA (Pix)' });
  });
  it('sem lista (ou acompanhamento sem a restrição) o prompt não menciona lojas confiáveis', async () => {
    const calls: Array<{ system: string; prompt: string }> = [];
    const llm: LlmClient = { async search(req) { calls.push(req); return { text: '{"findings":[]}', usage }; }, async chat() { throw new Error('x'); } };
    await runSmartCheck(llm, tracker, models, { trustedSites: [] });
    await runSmartCheck(llm, { ...tracker, onlyTrusted: false }, models, { trustedSites: ['amazon.com.br'] });
    for (const c of calls) expect(c.system + c.prompt).not.toContain('amazon.com.br');
  });
});

describe('alerta: mostra cupom e de onde veio; achados ignorados não contam', () => {
  const tracker: Tracker = { id: 1, name: 'PS5 Slim', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '2026-01-01T00:00:00Z', onlyTrusted: true };
  it('texto traz cupom e o site onde foi achado', () => {
    const d = decideAlert(tracker, [f({ value: 3400, store: 'Amazon', coupon: 'PROMOAGORA', via: 'ofertinha.com.br', sourceUrl: 'https://www.ofertinha.com.br/ps5' })], { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' });
    expect(d.alert!.text).toContain('Cupom: PROMOAGORA');
    expect(d.alert!.text).toContain('ofertinha.com.br');
    expect(d.alert!.text).toContain('Amazon');
  });
  it('achado ignorado não vale como preço confiável', () => {
    expect(isReliablePrice(f({ ignoredReason: 'loja desconhecida' }))).toBe(false);
    expect(isReliablePrice(f())).toBe(true);
  });
});

describe('pipeline: filtra por lojas confiáveis na descoberta', () => {
  const HAIKU = 'claude-haiku-5-5';
  const models = { routine: HAIKU, escalate: 'claude-sonnet-5-5' };
  const REGEX = 'R\\$\\s*([\\d.,]+)';
  const base: NewTracker = {
    name: 'PS5 Slim', kind: 'price', goal: 'PS5 Slim digital', include: ['PS5'], exclude: [], intervalMinutes: 60,
    alertCondition: { type: 'below_value', value: 4000 }, digest: 'none', onlyTrusted: true,
  };
  const AMAZON = 'https://www.amazon.com.br/dp/PS5';
  const OFERTA = 'https://www.ofertinha.com.br/ps5';
  const GO = 'https://www.ofertinha.com.br/go/ps5';
  const DESC = 'https://www.lojadesconhecida.com/ps5';
  const page = (p: string) => `<html><body><h1>Console PS5</h1><p>Por R$ ${p}</p></body></html>`;

  function setup(tracker: NewTracker = base) {
    const db = openDb(':memory:');
    const t = db.createTracker(tracker);
    const sent: string[] = [];
    const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
    const now = () => new Date('2026-01-10T10:00:00Z');
    const fetched: string[] = [];
    const pages: Record<string, string> = { [AMAZON]: ld(3600), [OFERTA]: `<a href="${GO}">comprar</a>${page('3524,00')}`, [DESC]: `<a href="${DESC}/comprar">comprar</a>${page('2000,00')}` };
    const fetchPage = async (url: string): Promise<FetchResult> => { fetched.push(url); return pages[url] ? { ok: true, html: pages[url] } : { ok: false, kind: 'http', status: 404, message: '404' }; };
    const resolveFinalUrl = async (url: string) => (url === GO ? ({ ok: true as const, finalUrl: AMAZON }) : ({ ok: true as const, finalUrl: url }));
    const items = [
      { found: true, value: 3600, currency: 'BRL', title: 'Amazon', source_url: AMAZON, evidence: 'e', confidence: 0.9, price_regex: REGEX },
      { found: true, value: 3524, currency: 'BRL', title: 'Ofertinha', source_url: OFERTA, store: 'Amazon', store_url: GO, coupon: 'PROMOAGORA', evidence: 'e', confidence: 0.9, price_regex: REGEX },
      { found: true, value: 2000, currency: 'BRL', title: 'Loja X', source_url: DESC, store: 'LojaX', store_url: `${DESC}/comprar`, evidence: 'e', confidence: 0.9, price_regex: REGEX },
    ];
    const llm: LlmClient = {
      async search(req) { return { text: JSON.stringify({ findings: items }), usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } }; },
      async chat() { throw new Error('x'); },
    };
    const notifier = new Notifier(db, transport, now);
    return { db, t, sent, fetched, deps: { db, llm, notifier, models, now, fetchPage, resolveFinalUrl } };
  }

  it('o menor preço entre as ofertas aceitas (com cupom, via site desconhecido) vence; a de loja desconhecida é ignorada', async () => {
    const s = setup();
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true);
    expect(s.sent[0]).toContain('Menor achado: R$ 3.600,00'); // vale o preço lido na loja (a Amazon), não o do site de cupom
    expect(s.sent[0]).toContain('Cupom: PROMOAGORA'); // o cupom do site de ofertas é mantido
    expect(s.sent[0]).toContain('3.524,00'); // e o que o site informava
    expect(s.sent[0]).toContain('ofertinha.com.br');
    expect(s.sent[0]).not.toContain('2.000,00');
    const check = s.db.listChecks(s.t.id)[0];
    const ignored = check.findings.filter((x) => x.ignoredReason);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].sourceUrl).toBe(DESC);
    expect(ignored[0].ignoredReason).toMatch(/não leva a uma loja confiável/i);
    expect(s.db.lastValue(s.t.id)).toBe(3600); // o ignorado (2000) não vira referência
  });

  it('só as ofertas aceitas viram fontes; a via loja confiável fica marcada como verificada', async () => {
    const s = setup();
    await runCheck(s.deps, s.t.id);
    const urls = s.db.listSources(s.t.id).map((x) => x.url).sort();
    expect(urls).toEqual([AMAZON]); // a oferta do site de cupom e a da Amazon acabam na mesma página da loja: a fonte é a loja
    expect(s.db.listSources(s.t.id)[0].origin).toMatchObject({ via: 'ofertinha.com.br', coupon: 'PROMOAGORA' });
  });

  it('a rotina só lê fontes de lojas confiáveis ou verificadas; fonte de site desconhecido sem verificação é pulada', async () => {
    const s = setup();
    await runCheck(s.deps, s.t.id);
    s.db.upsertSource(s.t.id, { url: OFERTA, label: 'Ofertinha', status: 'ok', lastValue: 3524, rule: { type: 'regex', pattern: REGEX }, trustedVia: true }); // verificada como via loja confiável
    s.db.upsertSource(s.t.id, { url: DESC, label: 'Loja X', status: 'ok', lastValue: 2000, rule: { type: 'regex', pattern: REGEX } });
    s.fetched.length = 0;
    const later = { ...s.deps, now: () => new Date('2026-01-10T11:05:00Z') };
    await runCheck(later, s.t.id);
    expect(s.fetched).toContain(AMAZON);
    expect(s.fetched).toContain(OFERTA);
    expect(s.fetched).not.toContain(DESC);
  });

  it('com "só lojas confiáveis" desligado, nada é filtrado', async () => {
    const s = setup({ ...base, onlyTrusted: false });
    await runCheck(s.deps, s.t.id);
    expect(s.sent[0]).toContain('Menor achado: R$ 2.000,00');
    expect(s.db.listChecks(s.t.id)[0].findings.some((x) => x.ignoredReason)).toBe(false);
  });

  it('lista vazia = sem restrição', async () => {
    const s = setup();
    s.db.setSetting('trusted_sites', '[]');
    await runCheck(s.deps, s.t.id);
    expect(s.sent[0]).toContain('Menor achado: R$ 2.000,00');
  });

  it('acompanhamento de notícias não é filtrado por lojas', async () => {
    const s = setup({ ...base, kind: 'news', alertCondition: { type: 'new_items' } });
    const r = await runCheck(s.deps, s.t.id);
    expect(r.ok).toBe(true);
    expect(s.db.listChecks(s.t.id)[0].findings.some((x) => x.ignoredReason)).toBe(false);
  });
});

describe('API: lista de sites confiáveis e chave por acompanhamento', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => { server?.closeAllConnections?.(); server ? server.close(() => r()) : r(); }));
  async function api() {
    const db = openDb(':memory:');
    const deps: ApiDeps = {
      token: 't', db, now: () => new Date('2026-01-01T12:00:00Z'), hasApiKey: () => true, setApiKey: async () => undefined,
      whatsappStatus: () => ({ status: 'ready' }), newSetupSession: () => undefined, runCheckNow: async () => ({ ok: true, alerted: false, baseline: false }),
      buildId: 'b', shutdown: () => undefined, sendTestMessage: async () => ({ ok: true }),
    };
    server = createApi(deps);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, json: raw ? JSON.parse(raw) : undefined };
    };
    return { db, call };
  }
  const goodInput = { name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' };

  it('GET /settings traz a lista padrão; PUT normaliza e guarda; vazio é permitido', async () => {
    const { call } = await api();
    expect((await call('GET', '/settings')).json.trustedSites).toEqual(DEFAULT_TRUSTED_SITES);
    const put = await call('PUT', '/settings', { trustedSites: ['https://www.Amazon.com.br/', 'kabum.com.br', 'amazon.com.br'] });
    expect(put.json.trustedSites).toEqual(['amazon.com.br', 'kabum.com.br']);
    expect((await call('GET', '/settings')).json.trustedSites).toEqual(['amazon.com.br', 'kabum.com.br']);
    expect((await call('PUT', '/settings', { trustedSites: [] })).json.trustedSites).toEqual([]);
  });

  it('novo acompanhamento vem com "só lojas confiáveis" ligado; PATCH muda sem apagar as fontes', async () => {
    const { db, call } = await api();
    const created = await call('POST', '/trackers', goodInput);
    expect(created.json.onlyTrusted).toBe(true);
    db.upsertSource(created.json.id, { url: 'https://www.amazon.com.br/dp/x', status: 'ok' });
    const patched = await call('PATCH', `/trackers/${created.json.id}`, { onlyTrusted: false });
    expect(patched.json.onlyTrusted).toBe(false);
    expect(db.listSources(created.json.id)).toHaveLength(1);
    expect((await call('POST', '/trackers', { ...goodInput, onlyTrusted: false })).json.onlyTrusted).toBe(false);
  });
});

describe('banco: novos acompanhamentos nascem com only_trusted ligado e fontes ganham trusted_via', () => {
  it('createTracker sem o campo grava onlyTrusted=true', () => {
    const db = openDb(':memory:');
    const t = db.createTracker({ name: 'x', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none' });
    expect(t.onlyTrusted).toBe(true);
    const s = db.upsertSource(t.id, { url: 'https://l/a', status: 'ok', trustedVia: true });
    expect(s.trustedVia).toBe(true);
  });
});
