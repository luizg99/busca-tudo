import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import { decideAlert } from '../src/service/decide';
import { learnSources } from '../src/service/sources';
import { verifyAtDestination } from '../src/service/destination';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker, Tracker } from '../src/shared/types';

const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
const page = (price: string) => `<html><body><h1>Console PS5 Slim</h1><p>Console PS5 Slim por R$ ${price} no Pix</p></body></html>`;
const JS_ONLY = '<html><body><div id="app">carregando…</div></body></html>';
const item = (url: string, value: number, extra: Record<string, unknown> = {}) => ({ found: true, value, currency: 'BRL', title: url, source_url: url, evidence: 'e', confidence: 0.9, ...extra });
const NONE = [{ found: false, evidence: 'nada', confidence: 0.9 }];

function setup(opts: { onlyTrusted?: boolean } = {}) {
  const base: NewTracker = { name: 'PS5 Slim', kind: 'price', goal: 'PS5 Slim digital', include: ['PS5'], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none', onlyTrusted: opts.onlyTrusted ?? false };
  const db = openDb(':memory:');
  const t = db.createTracker(base);
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  let clock = new Date('2026-01-10T10:00:00Z').getTime();
  const now = () => new Date(clock);
  const pages: Record<string, string> = {};
  const fetchPage = async (url: string): Promise<FetchResult> => (pages[url] !== undefined ? { ok: true, html: pages[url] } : { ok: false, kind: 'http', status: 404, message: 'O site respondeu com erro HTTP 404.' });
  const script: unknown[][] = [];
  let searches = 0;
  let chats = 0;
  const chatReplies: string[] = [];
  const llm: LlmClient = {
    async search(req) {
      searches++;
      const next = script.shift();
      if (!next) throw new Error('sem resposta de busca no script');
      return { text: JSON.stringify({ findings: next }), usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } };
    },
    async chat(req) {
      chats++;
      const text = chatReplies.shift();
      if (text === undefined) throw new Error('IA de leitura não prevista neste teste');
      return { text, toolUses: [], content: [], usage: { model: req.model, inputTokens: 400, outputTokens: 20, searches: 0 } };
    },
  };
  const notifier = new Notifier(db, transport, now);
  return {
    db, t, sent, pages, script, chatReplies,
    advance: (min: number) => { clock += min * 60000; },
    searches: () => searches, chats: () => chats,
    deps: { db, llm, notifier, models, now, fetchPage, resolveFinalUrl: async (u: string) => ({ ok: true as const, finalUrl: u }) },
  };
}

describe('#1 busca vazia não trava depois de mudar o produto ou ligar só lojas confiáveis', () => {
  it('depois de mudar o produto (fontes apagadas), a próxima verificação busca', async () => {
    const s = setup();
    s.script.push(NONE);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(1);
    // o usuário muda o produto: a API apaga as fontes e pede busca nova
    s.db.deleteSources(s.t.id);
    s.db.requestSearch(s.t.id);
    s.advance(15);
    s.pages['https://a.com/ps5'] = page('3.600,00');
    s.script.push([item('https://a.com/ps5', 3600)]);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(2);
    // pedido atendido: a trava das 6 h volta a valer
    expect(s.db.searchRequested(s.t.id)).toBe(false);
  });

  it('com "só lojas confiáveis" e só fontes de lojas fora da lista, busca; se nada for achado, não repete a cada 15 min', async () => {
    const s = setup({ onlyTrusted: true });
    s.db.upsertSource(s.t.id, { url: 'https://desconhecida.com/ps5', label: 'X', status: 'ok', lastValue: 3000, rule: { type: 'regex', pattern: 'por R\\$\\s{0,3}([\\d.]+,\\d{2})' } });
    s.script.push(NONE);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(1);
    // a fonte fora da lista nunca seria lida: sai na busca
    expect(s.db.listSources(s.t.id)).toHaveLength(0);
    for (let i = 0; i < 3; i++) { s.advance(15); await runCheck(s.deps, s.t.id); }
    expect(s.searches()).toBe(1);
  });
});

describe('#2 busca do dia só com sites ilegíveis não apaga os que liam bem', () => {
  it('a loja A (que lia) continua quando a busca traz só a C (preço por JavaScript)', async () => {
    const s = setup();
    s.pages['https://a.com/ps5'] = page('3.600,00');
    s.script.push([item('https://a.com/ps5', 3600)]);
    await runCheck(s.deps, s.t.id);
    s.advance(25 * 60);
    s.pages['https://c.com/ps5'] = JS_ONLY;
    s.script.push([item('https://c.com/ps5', 3500)]);
    await runCheck(s.deps, s.t.id);
    const list = s.db.listSources(s.t.id).map((x) => `${x.url}:${x.status}`).sort();
    expect(list).toEqual(['https://a.com/ps5:ok', 'https://c.com/ps5:unreadable']);
    s.advance(15);
    s.pages['https://a.com/ps5'] = page('3.400,00');
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true); // A segue sendo lida a cada 15 min
  });
});

describe('#4 site que some e volta não repete o aviso', () => {
  it('site ilegível já avisado, fora da busca num dia e de volta no outro: sem aviso repetido', async () => {
    const s = setup();
    s.pages['https://a.com/ps5'] = page('3.600,00');
    s.pages['https://js.com/ps5'] = JS_ONLY;
    s.script.push([item('https://a.com/ps5', 3600), item('https://js.com/ps5', 3500)]);
    await runCheck(s.deps, s.t.id);
    const warnings = () => s.sent.filter((m) => m.includes('não consegui ler') && m.includes('js.com'));
    expect(warnings()).toHaveLength(1);
    s.advance(25 * 60);
    s.script.push([item('https://a.com/ps5', 3600)]); // some
    await runCheck(s.deps, s.t.id);
    expect(s.db.listSources(s.t.id).map((x) => x.url)).toEqual(['https://a.com/ps5']);
    s.advance(25 * 60);
    s.script.push([item('https://a.com/ps5', 3600), item('https://js.com/ps5', 3500)]); // volta
    await runCheck(s.deps, s.t.id);
    expect(s.db.listSources(s.t.id)).toHaveLength(2);
    expect(warnings()).toHaveLength(1);
  });
});

describe('#3 conferir na loja: o número solto na página não basta', () => {
  const tracker = { id: 1, name: 'PS5 Slim', kind: 'price', goal: 'PS5 Slim digital', include: ['PS5'], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: true } as Tracker;
  const STORE = 'https://www.amazon.com.br/dp/PS5';
  const mk = (html: string, chat: () => string) => {
    let chats = 0;
    const llm: LlmClient = { async search() { throw new Error('x'); }, async chat(req) { chats++; return { text: chat(), toolUses: [], content: [], usage: { model: req.model, inputTokens: 1, outputTokens: 1, searches: 0 } }; } };
    return { chats: () => chats, deps: { fetchPage: async (): Promise<FetchResult> => ({ ok: true, html }), resolve: async (u: string) => ({ ok: true as const, finalUrl: u }), llm, model: 'm', tracker, trusted: ['amazon.com.br'] } };
  };
  const blogOffer: Finding = { found: true, value: 1499, currency: 'BRL', title: 'PS5', sourceUrl: 'https://blog.com/ps5', storeUrl: STORE, store: 'Amazon', via: 'blog.com', evidence: 'e', confidence: 0.9 };

  it('oferta de site de cupom: o valor do blog que aparece num "compre junto" não confirma; vale a leitura do produto', async () => {
    const html = '<html><body><h1>Console PS5 Slim</h1><p>Por R$ 1.899,00</p><p>Compre junto: controle por R$ 1.499,00</p></body></html>';
    const m = mk(html, () => '{"value": 1899}');
    const out = await verifyAtDestination([blogOffer], m.deps);
    expect(m.chats()).toBe(1);
    expect(out.findings[0]).toMatchObject({ value: 1899, claimedValue: 1499 });
  });

  it('oferta direta: o código confirma só se o preço aparece junto do nome do produto', async () => {
    const direct: Finding = { found: true, value: 3600, currency: 'BRL', title: 'PS5', sourceUrl: STORE, evidence: 'e', confidence: 0.9 };
    const near = mk('<html><body><h1>Console PS5 Slim</h1><p>Por R$ 3.600,00</p></body></html>', () => '{"value": null}');
    expect((await verifyAtDestination([direct], near.deps)).findings[0]).toMatchObject({ value: 3600 });
    expect(near.chats()).toBe(0);
    const far = mk(`<html><body><h1>Console PS5 Slim</h1><p>${'texto '.repeat(200)}</p><p>Outro item R$ 3.600,00</p></body></html>`, () => '{"value": 3999}');
    const r = await verifyAtDestination([direct], far.deps);
    expect(far.chats()).toBe(1);
    expect(r.findings[0].value).toBe(3999);
  });
});

describe('#5 juntar ofertas da mesma página mantém o link do blog', () => {
  it('oferta direta + oferta do blog na mesma página: o cupom e o "Achado em" ficam', async () => {
    const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: true } as Tracker;
    const STORE = 'https://www.amazon.com.br/dp/PS5';
    const html = '<script type="application/ld+json">{"@type":"Product","name":"PS5","offers":{"@type":"Offer","price":"3600","priceCurrency":"BRL"}}</script>';
    const deps = { fetchPage: async (): Promise<FetchResult> => ({ ok: true, html }), resolve: async (u: string) => ({ ok: true as const, finalUrl: u }), model: 'm', tracker, trusted: ['amazon.com.br'] };
    const out = await verifyAtDestination([
      { found: true, value: 3600, currency: 'BRL', title: 'PS5', sourceUrl: STORE, evidence: 'e', confidence: 0.9 },
      { found: true, value: 3524, currency: 'BRL', title: 'PS5', sourceUrl: 'https://cupomblog.com/ps5', storeUrl: STORE, store: 'Amazon', via: 'cupomblog.com', coupon: 'PROMO', evidence: 'e', confidence: 0.9 },
    ], deps);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ coupon: 'PROMO', viaUrl: 'https://cupomblog.com/ps5' });
  });
});

describe('#6 a busca diária não reensina com IA uma regra que ainda funciona', () => {
  it('regra guardada que ainda lê o preço é mantida, sem chamar a IA', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker({ name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none' });
    const rule = { type: 'regex' as const, pattern: '([\\d.]+,\\d{2})' };
    db.upsertSource(t.id, { url: 'https://a.com/x', status: 'ok', lastValue: 3524, rule });
    let chats = 0;
    const llm: LlmClient = { async search() { throw new Error('x'); }, async chat() { chats++; throw new Error('não devia chamar'); } };
    const html = '<html><body><span>3.524,00</span></body></html>'; // sem palavras: o código não monta regra nova
    await learnSources({ db, fetchPage: async () => ({ ok: true, html }), llm, model: 'm' }, t, [{ found: true, value: 3524, currency: 'BRL', sourceUrl: 'https://a.com/x', evidence: 'e', confidence: 0.9 }]);
    expect(chats).toBe(0);
    expect(db.listSources(t.id)[0].rule).toEqual(rule);
  });
});

describe('#7 no máximo 4 leituras por IA ao mesmo tempo', () => {
  it('20 ofertas sem dados estruturados não disparam 20 chamadas simultâneas', async () => {
    const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: ['PS5'], exclude: [], intervalMinutes: 15, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: false } as Tracker;
    let inFlight = 0; let max = 0;
    const llm: LlmClient = {
      async search() { throw new Error('x'); },
      async chat(req) { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 10)); inFlight--; return { text: '{"value": 3555}', toolUses: [], content: [], usage: { model: req.model, inputTokens: 1, outputTokens: 1, searches: 0 } }; },
    };
    const html = '<html><body><h1>PS5</h1><p>PS5 por R$ 3.555,00</p></body></html>';
    const findings: Finding[] = Array.from({ length: 20 }, (_, i) => ({ found: true, value: 3500 + i, currency: 'BRL', title: 'PS5', sourceUrl: `https://loja${i}.com/ps5`, evidence: 'e', confidence: 0.9 }));
    const out = await verifyAtDestination(findings, { fetchPage: async () => ({ ok: true, html }), resolve: async (u: string) => ({ ok: true as const, finalUrl: u }), llm, model: 'm', tracker, trusted: [] });
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(4);
    expect(out.findings.every((f) => f.value === 3555)).toBe(true);
  });
});

describe('#9 alerta: cada fonte numa linha, com nome e link juntos', () => {
  const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: true } as Tracker;
  const ctx = { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' };
  it('loja e site de cupom em linhas organizadas, sem repetir o blog nem o link solto', () => {
    const text = decideAlert(tracker, [{ found: true, value: 3400, currency: 'BRL', title: 'PS5', sourceUrl: 'https://www.amazon.com.br/dp/PS5', store: 'Amazon', storeUrl: 'https://ofertinha.com.br/go/ps5', via: 'ofertinha.com.br', viaUrl: 'https://ofertinha.com.br/post-ps5', coupon: 'PROMO', evidence: 'e', confidence: 0.9 }], ctx).alert!.text;
    const lines = text.split('\n');
    expect(lines).toContain('Loja: Amazon — https://www.amazon.com.br/dp/PS5');
    expect(lines).toContain('Achado em: ofertinha.com.br — https://ofertinha.com.br/post-ps5');
    expect(text.split('ofertinha.com.br/post-ps5')).toHaveLength(2); // uma vez só
    expect(lines).not.toContain('https://www.amazon.com.br/dp/PS5'); // sem link solto
    expect(text).not.toContain('Comprar:');
    expect(text).not.toContain('· achado em');
  });
  it('sem nome da loja, usa o domínio', () => {
    const text = decideAlert(tracker, [{ found: true, value: 3400, currency: 'BRL', title: 'PS5', sourceUrl: 'https://www.kabum.com.br/produto/1', evidence: 'e', confidence: 0.9 }], ctx).alert!.text;
    expect(text.split('\n')).toContain('Loja: kabum.com.br — https://www.kabum.com.br/produto/1');
  });
});
