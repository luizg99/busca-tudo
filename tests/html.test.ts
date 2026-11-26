import { describe, it, expect } from 'vitest';
import { htmlToText, extractGenericPrice, snippetsAround } from '../src/service/html';

describe('htmlToText', () => {
  it('remove script/style/comentários e tags, decodifica entidades e compacta espaços', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var preco = "R$ 1,00"</script></head>
      <body><!-- R$ 2,00 --><h1>PS5&nbsp;Slim &#8211; Digital</h1><p>Por <b>R$ 3524,00</b> &amp; frete</p></body></html>`;
    const t = htmlToText(html);
    expect(t).toBe('PS5 Slim – Digital Por R$ 3524,00 & frete');
    expect(t).not.toContain('1,00');
    expect(t).not.toContain('2,00');
  });
});

describe('extractGenericPrice', () => {
  const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  it('lê offers.price de um Product em JSON-LD', () => {
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: '3524.00', priceCurrency: 'BRL' } }))).toBe(3524);
  });
  it('lê lowPrice de AggregateOffer e o menor preço quando há várias ofertas', () => {
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 3400.5, highPrice: 4000 } }))).toBe(3400.5);
    expect(extractGenericPrice(ld({ '@type': 'Product', offers: [{ price: 4100 }, { price: 3999.9 }] }))).toBe(3999.9);
  });
  it('encontra Product dentro de @graph', () => {
    expect(extractGenericPrice(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Product', offers: { price: '2.999,90' } }] }))).toBe(2999.9);
  });
  it('lê meta product:price:amount e itemprop="price"', () => {
    expect(extractGenericPrice('<meta property="product:price:amount" content="3524.00">')).toBe(3524);
    expect(extractGenericPrice('<span itemprop="price" content="1999.90">R$ 1.999,90</span>')).toBe(1999.9);
  });
  it('ignora JSON-LD inválido e páginas sem preço', () => {
    expect(extractGenericPrice('<script type="application/ld+json">{quebrado</script>')).toBeUndefined();
    expect(extractGenericPrice('<html><body>nada aqui</body></html>')).toBeUndefined();
  });
});

describe('snippetsAround', () => {
  const text = 'Menu Início Ofertas '.repeat(40) + 'Console PS5 Slim Digital por R$ 3524,00 no pix ' + 'Rodapé contato '.repeat(60) + 'Outro item R$ 345,10 capinha';
  it('devolve janelas ao redor de valores em R$, com as mais ligadas às palavras-chave primeiro', () => {
    const out = snippetsAround(text, { keywords: ['PS5', 'Slim'], radius: 60, max: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('R$ 3524,00');
    expect(out[0]).toContain('PS5');
    expect(out[1]).toContain('R$ 345,10');
  });
  it('respeita o máximo de janelas e funde janelas que se sobrepõem', () => {
    const dense = 'a R$ 10,00 b R$ 11,00 c R$ 12,00 d';
    expect(snippetsAround(dense, { radius: 100, max: 3 })).toHaveLength(1);
    expect(snippetsAround(text, { radius: 60, max: 1 })).toHaveLength(1);
  });
  it('sem nenhum preço no texto devolve lista vazia', () => {
    expect(snippetsAround('sem preço aqui', {})).toEqual([]);
  });
});
