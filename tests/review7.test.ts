import { describe, it, expect } from 'vitest';
import { htmlToText, extractGenericPrice, snippetsAround } from '../src/service/html';
import { applyRule, isRiskyPattern, learnSources, readSource } from '../src/service/sources';
import { openDb } from '../src/service/db';
import type { FetchResult } from '../src/service/fetcher';
import type { LlmClient } from '../src/service/llm';
import type { Finding, NewTracker, Tracker } from '../src/shared/types';

const nt: NewTracker = {
  name: 'PS5 Slim Digital', kind: 'price', goal: 'Preço do PS5 Slim digital novo', include: ['PS5 Slim Digital'], exclude: ['usado'],
  intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none',
};
const tracker: Tracker = { ...nt, id: 1, status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

describe('#5 htmlToText em tempo linear (página hostil não congela o serviço)', () => {
  it('100 mil "<", 50 mil "<!--" e 30 mil "<script>" processam em bem menos de 1,5 s', () => {
    const t0 = Date.now();
    htmlToText('<'.repeat(100_000));
    htmlToText('<!--'.repeat(50_000));
    htmlToText('<script>'.repeat(30_000));
    htmlToText('<a href="x'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('HTML grande e normal (1,5 MB) também é rápido', () => {
    const big = '<div><span>R$</span><span>3.499</span><span>,00</span><p>texto &amp; mais</p></div>'.repeat(18_000);
    const t0 = Date.now();
    const text = htmlToText(big);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(text).toContain('R$3.499,00');
  });
  it('mantém o comportamento: menor-que solto vira texto, comentário e script somem, comentário sem fim descarta o resto', () => {
    expect(htmlToText('a < b e c > d')).toBe('a < b e c > d');
    expect(htmlToText('x<!-- segredo -->y<script>var a="R$ 1,00"</script>z')).toBe('x y z');
    expect(htmlToText('antes<!-- nunca fecha R$ 9,99')).toBe('antes');
  });
});

describe('#6 preços sem centavos e markup de lojas grandes', () => {
  it('snippetsAround reconhece "R$ 3.499" sem centavos', () => {
    expect(snippetsAround('Console por R$ 3.499 à vista', { radius: 10 })[0]).toContain('R$ 3.499');
  });
  it('markup estilo Amazon (inteiro, separador e fração em spans) vira R$3.499,00', () => {
    const html = '<span>R$</span><span class="whole">3.499<span class="decimal">,</span></span><span class="fraction">00</span>';
    expect(htmlToText(html)).toBe('R$3.499,00');
  });
  it('markup estilo Mercado Livre (símbolo, inteiro e centavos em spans, sem vírgula) vira R$3.499,00', () => {
    const html = '<span class="symbol">R$</span><span class="fraction">3.499</span><span class="cents">00</span>';
    expect(htmlToText(html)).toBe('R$3.499,00');
  });
  it('não funde preço com a parcela seguinte nem número solto com outro', () => {
    expect(htmlToText('<span>R$ 3.524,00</span><span>12x de 293,67</span>')).toBe('R$ 3.524,00 12x de 293,67');
    expect(htmlToText('<b>Item 5</b><b>12 unidades</b>')).toBe('Item 5 12 unidades');
  });
  it('learnSources aceita preço inteiro (sem centavos) presente na página', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const f: Finding = { found: true, value: 3499, currency: 'BRL', title: 'L', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9 };
    await learnSources({ db, fetchPage: async () => ({ ok: true, html: '<p>Console por R$ 3.499 à vista</p>' }) }, t, [f]);
    expect(db.listSources(t.id)[0].status).toBe('ok');
  });
});

describe('#7 trechos enviados à IA têm tamanho limitado', () => {
  it('400 preços colados não viram um trecho gigante: no máximo 3 janelas pequenas', () => {
    const text = Array.from({ length: 400 }, (_, i) => `R$ ${100 + i},00 `).join('x'.repeat(8));
    const out = snippetsAround(text, { radius: 300, max: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
    for (const w of out) expect(w.length).toBeLessThanOrEqual(700);
  });
  it('janelas que se sobrepõem não são repetidas', () => {
    const out = snippetsAround('a R$ 10,00 b R$ 11,00 c R$ 12,00 d', { radius: 100, max: 3 });
    expect(out).toHaveLength(1);
  });
});

describe('#8 extractGenericPrice não estoura a pilha com milhares de ofertas', () => {
  it('150 mil ofertas', () => {
    const offers = Array.from({ length: 150_000 }, (_, i) => ({ price: 1000 + i }));
    expect(extractGenericPrice(ld({ '@type': 'Product', offers }))).toBe(1000);
  });
});

describe('pesquisa: dados estruturados ignoram esgotado, outra moeda e preço de tabela', () => {
  it('oferta esgotada não vale', () => {
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: [{ price: 3000, availability: 'https://schema.org/OutOfStock' }, { price: 4100, availability: 'InStock' }] }))).toBe(4100);
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: { price: 3000, availability: 'https://schema.org/SoldOut' } }))).toBeUndefined();
  });
  it('moeda diferente de BRL não vale; sem moeda informada vale', () => {
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: [{ price: 499, priceCurrency: 'USD' }, { price: 3999, priceCurrency: 'BRL' }] }))).toBe(3999);
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: { price: 3999 } }))).toBe(3999);
  });
  it('priceSpecification: preço de tabela (ListPrice/Strikethrough) não vale, o preço de venda vale', () => {
    const offers = { '@type': 'Offer', priceSpecification: [
      { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/ListPrice', price: 4500 },
      { '@type': 'UnitPriceSpecification', price: 3999 },
    ] };
    expect(extractGenericPrice(ld({ '@type': 'Product', offers }))).toBe(3999);
  });
});

describe('#4 leitor de dados estruturados só vale se o aprendizado confirmou', () => {
  const PAGE = `<html>${ld({ '@type': 'Product', offers: { price: 3999 } })}<body><h1>PS5 Slim Digital</h1><p>Por R$ 3.500,00 no pix</p></body></html>`;
  const usage = { model: 'claude-haiku-5-5', inputTokens: 300, outputTokens: 10, searches: 0 };
  const llm = (json: string): LlmClient => ({ async search() { throw new Error('x'); }, async chat() { return { text: json, toolUses: [], content: [], usage }; } });
  const deps = (l?: LlmClient) => ({ fetchPage: async (): Promise<FetchResult> => ({ ok: true, html: PAGE }), tracker, lastValue: 3500, llm: l, model: 'claude-haiku-5-5' });

  it('fonte sem regra NÃO usa o JSON-LD (3999 de tabela): vai para o plano B e lê o Pix', async () => {
    const r = await readSource(deps(llm('{"value": 3500}')), { url: 'https://l/a', label: 'L' });
    expect(r.result).toMatchObject({ ok: true, method: 'ai', value: 3500 });
  });
  it('regra regex quebrada sem genericOk também não cai no JSON-LD', async () => {
    const r = await readSource(deps(llm('{"value": 3500}')), { url: 'https://l/a', rule: { type: 'regex', pattern: 'sumiu\\s*([\\d,]+)' } });
    expect(r.result.method).toBe('ai');
  });
  it('regra regex quebrada com genericOk (aprendizado confirmou os dois) pode usar o JSON-LD', async () => {
    const page = `<html>${ld({ '@type': 'Product', offers: { price: 3500 } })}<body>nada</body></html>`;
    const r = await readSource({ ...deps(), fetchPage: async () => ({ ok: true, html: page }) }, { url: 'https://l/a', rule: { type: 'regex', pattern: 'sumiu\\s*([\\d,]+)', genericOk: true } });
    expect(r.result).toMatchObject({ ok: true, method: 'generic', value: 3500 });
  });
  it('learnSources marca genericOk quando regex e dados estruturados reproduzem o mesmo preço', async () => {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    const page = `<html>${ld({ '@type': 'Product', offers: { price: 3500 } })}<body><p>PS5 Slim Digital por R$ 3.500,00 no pix</p></body></html>`;
    const f: Finding = { found: true, value: 3500, currency: 'BRL', title: 'L', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9, priceRegex: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' };
    await learnSources({ db, fetchPage: async () => ({ ok: true, html: page }) }, t, [f]);
    expect(db.listSources(t.id)[0].rule).toMatchObject({ type: 'regex', genericOk: true });
  });
});

describe('#3 valor lido mas fora do esperado é "suspeito", não falha', () => {
  it('a regra lê 1500 (última leitura 3500): devolve suspectValue e não chama a IA', async () => {
    let chats = 0;
    const llm: LlmClient = { async search() { throw new Error('x'); }, async chat() { chats++; throw new Error('x'); } };
    const page = '<p>PS5 Slim Digital por R$ 1500,00 no pix</p>';
    const r = await readSource({ fetchPage: async () => ({ ok: true, html: page }), tracker, lastValue: 3500, llm, model: 'm' },
      { url: 'https://l/a', rule: { type: 'regex', pattern: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' } });
    expect(r.result).toMatchObject({ ok: false, suspectValue: 1500 });
    expect(r.result.error).toMatch(/fora do esperado/);
    expect(chats).toBe(0);
  });
  it('a IA lê 1500: também é suspeito', async () => {
    const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
    const llm: LlmClient = { async search() { throw new Error('x'); }, async chat() { return { text: '{"value": 1500}', toolUses: [], content: [], usage }; } };
    const r = await readSource({ fetchPage: async () => ({ ok: true, html: '<p>por R$ 1500,00</p>' }), tracker, lastValue: 3500, llm, model: 'm' }, { url: 'https://l/a' });
    expect(r.result).toMatchObject({ ok: false, suspectValue: 1500 });
  });
});

describe('#9 falha passageira ao aprender não rebaixa a fonte', () => {
  const f: Finding = { found: true, value: 3500, currency: 'BRL', title: 'L', sourceUrl: 'https://l/a', evidence: 'e', confidence: 0.9 };
  async function learnWith(result: FetchResult) {
    const db = openDb(':memory:');
    const t = db.createTracker(nt);
    await learnSources({ db, fetchPage: async () => result }, t, [f]);
    return db.listSources(t.id)[0];
  }
  it('timeout, rede, bloqueio (429) e erro 5xx deixam a fonte como "failing" (a rotina tenta de novo)', async () => {
    for (const r of [
      { ok: false, kind: 'timeout', message: 'demorou' }, { ok: false, kind: 'network', message: 'rede' },
      { ok: false, kind: 'blocked', status: 429, message: 'bloqueou' }, { ok: false, kind: 'http', status: 503, message: 'erro 503' },
    ] as FetchResult[]) {
      expect((await learnWith(r)).status, JSON.stringify(r)).toBe('failing');
    }
  });
  it('404/410 (página não existe) e URL inválida continuam "unreadable"', async () => {
    expect((await learnWith({ ok: false, kind: 'http', status: 404, message: '404' })).status).toBe('unreadable');
    expect((await learnWith({ ok: false, kind: 'invalid', message: 'inválido' })).status).toBe('unreadable');
  });
});

describe('#12 regex: sequências de ilimitados e padrão lento lembrado', () => {
  it('muitos quantificadores ilimitados em sequência são arriscados; regras comuns não', () => {
    expect(isRiskyPattern('(.*)(.*)(.*)(.*)(.*)(.*)(.*)x([\\d]+)')).toBe(true);
    expect(isRiskyPattern('.*.*.*.*.*.*.*x')).toBe(true);
    expect(isRiskyPattern('Digital.{0,30}?R\\$\\s*([\\d.,]+)\\s*no pix')).toBe(false);
    expect(isRiskyPattern('Sony.{0,40}?R\\$\\s*([\\d.,]+)\\s*(?:no pix|à vista)')).toBe(false);
  });
  it('um padrão que estourou o tempo é lembrado e não gasta mais 150 ms nas chamadas seguintes', () => {
    const text = 'a'.repeat(8000) + 'b'; // nunca casa o "c" final: o padrão (5 "a*", abaixo do limite do filtro) explora tudo
    const rule = { type: 'regex' as const, pattern: 'a*a*a*a*a*c' };
    const t1 = Date.now();
    expect(applyRule(rule, text)).toBeUndefined(); // estoura o limite de tempo (~150 ms)
    expect(Date.now() - t1).toBeGreaterThan(100);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) expect(applyRule(rule, text)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(100); // lembrado: não paga o tempo de novo
  });
});
