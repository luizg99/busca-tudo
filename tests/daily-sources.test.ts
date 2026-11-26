import { describe, it, expect } from 'vitest';
import { runCheck } from '../src/service/pipeline';
import { openDb } from '../src/service/db';
import { Notifier, type Transport } from '../src/service/notifier';
import { induceRule, teachRule } from '../src/service/teach';
import { applyRule } from '../src/service/sources';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { NewTracker } from '../src/shared/types';

const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };
const page = (name: string, price: string) => `<html><body><h1>${name}</h1><p>Frete R$ 19,90</p><p>Console PS5 Slim por R$ ${price} no Pix</p></body></html>`;
const item = (url: string, value: number, extra: Record<string, unknown> = {}) => ({ found: true, value, currency: 'BRL', title: url, source_url: url, evidence: 'e', confidence: 0.9, ...extra });

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
  const script: Array<unknown[] | Error> = [];
  let searches = 0;
  let chats = 0;
  const chatReplies: string[] = [];
  const llm: LlmClient = {
    async search(req) {
      searches++;
      const next = script.shift();
      if (next === undefined) throw new Error('sem resposta de busca no script');
      if (next instanceof Error) throw next;
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
const urls = (s: ReturnType<typeof setup>) => s.db.listSources(s.t.id).map((x) => x.url).sort();

describe('lista de sites renovada a cada busca diária', () => {
  it('a busca do dia seguinte manda: site que sumiu sai, o que continua mantém a regra, o novo entra', async () => {
    const s = setup();
    s.pages['https://a.com/ps5'] = page('A', '3.600,00');
    s.pages['https://b.com/ps5'] = page('B', '3.700,00');
    s.script.push([item('https://a.com/ps5', 3600), item('https://b.com/ps5', 3700)]);
    await runCheck(s.deps, s.t.id);
    expect(urls(s)).toEqual(['https://a.com/ps5', 'https://b.com/ps5']);
    const ruleB = s.db.listSources(s.t.id).find((x) => x.url === 'https://b.com/ps5')!.rule;
    expect(ruleB).toBeDefined();

    s.advance(25 * 60);
    s.pages['https://c.com/ps5'] = page('C', '3.650,00');
    s.script.push([item('https://b.com/ps5', 3700), item('https://c.com/ps5', 3650)]);
    await runCheck(s.deps, s.t.id);
    expect(urls(s)).toEqual(['https://b.com/ps5', 'https://c.com/ps5']);
    expect(s.db.listSources(s.t.id).find((x) => x.url === 'https://b.com/ps5')!.rule).toEqual(ruleB);
  });

  it('busca que falha ou que não acha nada não apaga os sites que já funcionavam', async () => {
    const s = setup();
    s.pages['https://a.com/ps5'] = page('A', '3.600,00');
    s.script.push([item('https://a.com/ps5', 3600)]);
    await runCheck(s.deps, s.t.id);
    s.advance(25 * 60);
    s.script.push(new Error('API fora do ar'));
    await runCheck(s.deps, s.t.id);
    expect(urls(s)).toEqual(['https://a.com/ps5']);
    s.advance(25 * 60);
    s.script.push([{ found: false, evidence: 'nada', confidence: 0.9 }]);
    await runCheck(s.deps, s.t.id);
    expect(urls(s)).toEqual(['https://a.com/ps5']);
  });

  it('guarda todos os sites que a busca trouxer (sem limite de 4 ou 10)', async () => {
    const s = setup();
    const items = [];
    for (let i = 0; i < 12; i++) {
      s.pages[`https://loja${i}.com/ps5`] = page(`L${i}`, `${3600 + i},00`);
      items.push(item(`https://loja${i}.com/ps5`, 3600 + i));
    }
    s.script.push(items);
    await runCheck(s.deps, s.t.id);
    expect(s.db.listSources(s.t.id)).toHaveLength(12);
  });

  it('busca que não achou nenhuma loja não se repete a cada 15 min (só depois de 6 h)', async () => {
    const s = setup();
    s.script.push([{ found: false, evidence: 'nada', confidence: 0.9 }]);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(1);
    for (let i = 0; i < 4; i++) {
      s.advance(15);
      const r = await runCheck(s.deps, s.t.id);
      expect(r.ok).toBe(true);
    }
    expect(s.searches()).toBe(1);
    s.advance(6 * 60);
    s.script.push([{ found: false, evidence: 'nada', confidence: 0.9 }]);
    await runCheck(s.deps, s.t.id);
    expect(s.searches()).toBe(2);
  });
});

describe('regra de leitura ensinada uma vez por dia (o código primeiro, a IA só se precisar)', () => {
  it('sem regra da IA e sem dados estruturados, o código monta a regra a partir de onde o preço aparece', () => {
    const html = page('A', '3.524,00');
    const rule = induceRule(html, 3524);
    expect(rule?.type).toBe('regex');
    expect(applyRule(rule!, html)).toBe(3524);
    // a regra continua lendo quando o preço muda
    expect(applyRule(rule!, page('A', '3.399,90'))).toBe(3399.9);
  });

  it('não monta regra se o preço não está no texto', () => {
    expect(induceRule('<html><body>carregando…</body></html>', 3524)).toBeUndefined();
  });

  it('a regra montada não depende de outros números que mudam (ex.: preço "de")', () => {
    const html = '<p>PS5 Slim de R$ 4.199,00 por R$ 3.905,00 no Pix</p>';
    const rule = induceRule(html, 3905)!;
    expect(applyRule(rule, '<p>PS5 Slim de R$ 4.299,00 por R$ 3.800,00 no Pix</p>')).toBe(3800);
  });

  it('teachRule: a IA propõe a regra e o código confere antes de aceitar', async () => {
    const html = page('A', '3.524,00');
    const mk = (text: string): LlmClient => ({ async search() { throw new Error('x'); }, async chat(req) { return { text, toolUses: [], content: [], usage: { model: req.model, inputTokens: 1, outputTokens: 1, searches: 0 } }; } });
    const ok = await teachRule(mk(JSON.stringify({ regex: 'Slim por R\\$\\s{0,3}([\\d.]+,\\d{2})' })), 'm', html, 3524);
    expect(ok.rule && applyRule(ok.rule, html)).toBe(3524);
    expect(ok.usages).toHaveLength(1);
    const wrong = await teachRule(mk(JSON.stringify({ regex: 'Frete R\\$\\s{0,3}([\\d.]+,\\d{2})' })), 'm', html, 3524);
    expect(wrong.rule).toBeUndefined(); // lê outro número: recusada
    const risky = await teachRule(mk(JSON.stringify({ regex: '(a+)+([\\d.,]+)' })), 'm', html, 3524);
    expect(risky.rule).toBeUndefined();
    const absent = await teachRule(mk('{}'), 'm', '<p>carregando</p>', 3524);
    expect(absent).toEqual({ usages: [] }); // preço fora do texto: nem chama a IA
  });

  it('na rotina, o site com regra ensinada é lido só pelo código (sem IA a cada 15 min)', async () => {
    const s = setup();
    s.pages['https://a.com/ps5'] = page('A', '3.600,00');
    s.script.push([item('https://a.com/ps5', 3600)]); // sem price_regex
    await runCheck(s.deps, s.t.id);
    expect(s.db.listSources(s.t.id)[0].rule?.type).toBe('regex');
    for (let i = 0; i < 3; i++) {
      s.advance(15);
      s.pages['https://a.com/ps5'] = page('A', `${3590 - i * 10},00`);
      const r = await runCheck(s.deps, s.t.id);
      expect(r.ok).toBe(true);
    }
    expect(s.chats()).toBe(0);
    expect(s.db.listChecks(s.t.id)[0].mode).toBe('routine');
  });
});

describe('blog de cupom: o link do blog fica guardado', () => {
  it('a fonte lida é a loja, e o link completo do blog aparece no alerta e na fonte', async () => {
    const s = setup({ onlyTrusted: true });
    const BLOG = 'https://www.blog.com.br/oferta-ps5';
    const AMZ = 'https://www.amazon.com.br/dp/PS5';
    s.pages[BLOG] = `<a href="${AMZ}">comprar</a> PS5 por R$ 3.524,00`;
    s.pages[AMZ] = page('Amazon', '3.600,00');
    s.script.push([item(BLOG, 3524, { store: 'Amazon', store_url: AMZ, coupon: 'PROMO10' })]);
    s.chatReplies.push('{"value": 3600}'); // sem dados estruturados na Amazon: o Haiku lê o trecho uma vez, na busca do dia
    await runCheck(s.deps, s.t.id);
    const src = s.db.listSources(s.t.id);
    expect(src.map((x) => x.url)).toEqual([AMZ]);
    expect(src[0].origin).toMatchObject({ viaUrl: BLOG, via: 'blog.com.br' });
    s.advance(15);
    s.pages[AMZ] = page('Amazon', '3.400,00');
    const r = await runCheck(s.deps, s.t.id);
    expect(r.alerted).toBe(true);
    expect(s.sent.at(-1)).toContain(`Achado em: ${BLOG}`);
  });
});
