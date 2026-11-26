import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { decideAlert } from '../src/service/decide';
import { Notifier, type Transport } from '../src/service/notifier';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { NewTracker } from '../src/shared/types';

const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
const BLOG = 'https://www.ofertinha.com.br/ps5';
const GO = 'https://www.ofertinha.com.br/go/ps5';
const AMZ = 'https://www.amazon.com.br/dp/PS5';
const jsonLd = (price: number) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'PS5', offers: { '@type': 'Offer', price: String(price), priceCurrency: 'BRL', availability: 'https://schema.org/InStock' } })}</script></head><body>PS5</body></html>`;
const blogHtml = `<a href="${GO}">comprar</a> PS5 por R$ 3.524,00`;

function setup(opts: { onlyTrusted?: boolean; pages: Record<string, string>; item?: Record<string, unknown>; chat?: string }) {
  const base: NewTracker = { name: 'PS5 Slim', kind: 'price', goal: 'PS5 Slim digital', include: ['PS5'], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', onlyTrusted: opts.onlyTrusted ?? true };
  const db = openDb(':memory:');
  const t = db.createTracker(base);
  const sent: string[] = [];
  const transport: Transport = { isReady: () => true, async sendToSelf(x) { sent.push(x); } };
  const now = () => new Date('2026-01-10T10:00:00Z');
  const fetched: string[] = [];
  const fetchPage = async (url: string): Promise<FetchResult> => {
    fetched.push(url);
    return opts.pages[url] !== undefined ? { ok: true, html: opts.pages[url] } : { ok: false, kind: 'http', status: 404, message: 'O site respondeu com erro HTTP 404.' };
  };
  const resolveFinalUrl = async (u: string) => ({ ok: true as const, finalUrl: u === GO ? AMZ : u });
  const item = { found: true, value: 3524, currency: 'BRL', title: 'PS5 com cupom', source_url: BLOG, store: 'Amazon', store_url: GO, coupon: 'PROMOAGORA', evidence: 'e', confidence: 0.9, ...opts.item };
  let chats = 0;
  const llm: LlmClient = {
    async search(req) { return { text: JSON.stringify({ findings: [item] }), usage: { model: req.model, inputTokens: 1000, outputTokens: 500, searches: 3 } }; },
    async chat(req) { chats++; return { text: opts.chat ?? '{"value": null}', toolUses: [], content: [], usage: { model: req.model, inputTokens: 500, outputTokens: 10, searches: 0 } }; },
  };
  const notifier = new Notifier(db, transport, now);
  return { db, t, sent, fetched, chats: () => chats, deps: { db, llm, notifier, models, now, fetchPage, resolveFinalUrl } };
}

describe('o preço que vale é o da página da loja de destino', () => {
  it('site de cupom → link leva à Amazon → usa o preço lido na Amazon, não o do blog', async () => {
    const s = setup({ pages: { [BLOG]: blogHtml, [AMZ]: jsonLd(3600) } });
    const r = await runCheck(s.deps, s.t.id);
    expect(s.fetched).toContain(AMZ);
    const f = s.db.listChecks(s.t.id)[0].findings[0];
    expect(f).toMatchObject({ value: 3600, sourceUrl: AMZ, via: 'ofertinha.com.br', claimedValue: 3524, coupon: 'PROMOAGORA' });
    expect(f.ignoredReason).toBeUndefined();
    expect(s.db.lastValue(s.t.id)).toBe(3600);
    expect(s.db.listSources(s.t.id).map((x) => x.url)).toEqual([AMZ]); // a fonte passa a ser a loja
    expect(r.ok).toBe(true);
  });

  it('a rotina lê o preço direto na loja (sem busca) e o alerta mostra preço, cupom e link da loja', async () => {
    const s = setup({ pages: { [BLOG]: blogHtml, [AMZ]: jsonLd(3600) }, item: {} });
    await runCheck(s.deps, s.t.id); // baseline
    // segunda busca com preço menor na loja: cria o alerta
    s.deps.fetchPage = async (u: string) => (u === AMZ ? { ok: true as const, html: jsonLd(3400) } : u === BLOG ? { ok: true as const, html: blogHtml } : { ok: false as const, kind: 'http' as const, status: 404, message: '404' });
    s.deps.now = () => new Date('2026-01-10T12:00:00Z');
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true);
    expect(s.sent.at(-1)).toContain('Menor achado: R$ 3.400,00');
    expect(s.sent.at(-1)).toContain('Cupom: PROMOAGORA');
    expect(s.sent.at(-1)).toContain(AMZ);
  });

  it('preço do site de cupom que não dá para conferir na loja é ignorado (pode estar desatualizado)', async () => {
    const s = setup({ pages: { [BLOG]: blogHtml } }); // a página da Amazon não abre
    await runCheck(s.deps, s.t.id);
    const f = s.db.listChecks(s.t.id)[0].findings[0];
    expect(f.ignoredReason).toMatch(/não conferido na loja de destino/i);
    expect(s.db.lastValue(s.t.id)).toBeUndefined();
  });

  it('oferta direta de loja confiável: o preço lido na página manda, e o da IA fica como informado', async () => {
    const s = setup({ pages: { [AMZ]: jsonLd(3700) }, item: { source_url: AMZ, store_url: undefined, coupon: undefined, value: 3500 } });
    await runCheck(s.deps, s.t.id);
    const f = s.db.listChecks(s.t.id)[0].findings[0];
    expect(f).toMatchObject({ value: 3700, sourceUrl: AMZ, claimedValue: 3500 });
    expect(f.via).toBeUndefined();
  });

  it('oferta direta que não dá para ler (JS): vale o valor da IA, mas marcada como não conferida e com aviso no alerta', async () => {
    const s = setup({ pages: { [AMZ]: '<html><body>carregando…</body></html>' }, item: { source_url: AMZ, store_url: undefined, coupon: undefined, value: 3500 } });
    await runCheck(s.deps, s.t.id);
    const f = s.db.listChecks(s.t.id)[0].findings[0];
    expect(f).toMatchObject({ value: 3500, unverified: true });
    expect(f.ignoredReason).toBeUndefined();
  });

  it('sem dados estruturados na loja, a IA (Haiku) lê o trecho da página', async () => {
    const page = '<html><body><h1>Console PS5 Slim Digital</h1><p>Por R$ 3.650,00 no Pix</p></body></html>';
    const s = setup({ pages: { [BLOG]: blogHtml, [AMZ]: page }, chat: '{"value": 3650}' });
    await runCheck(s.deps, s.t.id);
    expect(s.chats()).toBeGreaterThan(0);
    expect(s.db.listChecks(s.t.id)[0].findings[0]).toMatchObject({ value: 3650, sourceUrl: AMZ });
  });

  it('sem restrição de lojas (onlyTrusted desligado) também lê o preço no destino do link da loja', async () => {
    const s = setup({ onlyTrusted: false, pages: { [BLOG]: blogHtml, [AMZ]: jsonLd(3600) } });
    await runCheck(s.deps, s.t.id);
    expect(s.db.listChecks(s.t.id)[0].findings[0]).toMatchObject({ value: 3600, sourceUrl: AMZ, via: 'ofertinha.com.br' });
  });
});

describe('alerta com preço de loja', () => {
  const tracker = { id: 1, name: 'PS5', kind: 'price', goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: true } as never;
  const base = { found: true, value: 3400, currency: 'BRL', title: 't', sourceUrl: AMZ, evidence: 'e', confidence: 0.9 };
  it('mostra o que o site da oferta informava e avisa quando o preço não foi conferido', () => {
    const d1 = decideAlert(tracker, [{ ...base, claimedValue: 3524, coupon: 'PROMOAGORA' }], { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' });
    expect(d1.alert!.text).toContain('O site da oferta informava R$ 3.524,00; vale o preço lido na loja.');
    const d2 = decideAlert(tracker, [{ ...base, unverified: true }], { isNew: () => true, lastValue: 3600, now: '2026-01-02T12:00:00Z' });
    expect(d2.alert!.text).toContain('Preço não conferido na página da loja');
  });
});
