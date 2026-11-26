import { describe, it, expect } from 'vitest';
import { decideAlert, parsePrice, type DecisionContext } from '../src/service/decide';
import type { Tracker, Finding } from '../src/shared/types';

const tracker = (over: Partial<Tracker> = {}): Tracker => ({
  id: 1, name: 'PS5', kind: 'price', goal: 'menor preço', include: [], exclude: [], intervalMinutes: 60,
  alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '2026-01-01T00:00:00Z', ...over,
});
const price = (value: number, confidence = 0.9, sourceUrl = 'https://loja/a'): Finding =>
  ({ found: true, value, currency: 'BRL', sourceUrl, evidence: 'ev', confidence });
const ctx = (over: Partial<DecisionContext> = {}): DecisionContext =>
  ({ isNew: () => true, now: '2026-01-02T12:00:00Z', ...over });

describe('decideAlert (preço)', () => {
  it('sem lastValue só grava linha de base', () => {
    const d = decideAlert(tracker(), [price(100)], ctx());
    expect(d.baseline).toBe(true);
    expect(d.alert).toBeUndefined();
  });
  it('below_last: alerta só quando menor que o último', () => {
    expect(decideAlert(tracker(), [price(90)], ctx({ lastValue: 100 })).alert).toBeDefined();
    expect(decideAlert(tracker(), [price(100)], ctx({ lastValue: 100 })).alert).toBeUndefined();
    expect(decideAlert(tracker(), [price(110)], ctx({ lastValue: 100 })).alert).toBeUndefined();
  });
  it('texto do alerta traz nome, valor anterior, valor novo e link', () => {
    const a = decideAlert(tracker(), [price(90)], ctx({ lastValue: 100 })).alert!;
    expect(a.text).toContain('PS5');
    expect(a.text).toContain('90,00');
    expect(a.text).toContain('100,00');
    expect(a.text).toContain('https://loja/a');
    expect(a.value).toBe(90);
    expect(a.sourceUrl).toBe('https://loja/a');
  });
  it('below_value: alerta abaixo do limite, não acima', () => {
    const t = tracker({ alertCondition: { type: 'below_value', value: 50 } });
    expect(decideAlert(t, [price(49)], ctx()).alert).toBeDefined();
    expect(decideAlert(t, [price(51)], ctx()).alert).toBeUndefined();
  });
  it('ignora finding de baixa confiança', () => {
    const d = decideAlert(tracker(), [price(10, 0.4)], ctx({ lastValue: 100 }));
    expect(d.alert).toBeUndefined();
    expect(d.ignored).toHaveLength(1);
  });
  it('usa o menor valor entre as findings confiáveis', () => {
    const d = decideAlert(tracker(), [price(95, 0.9, 'u1'), price(80, 0.8, 'u2'), price(10, 0.2, 'u3')], ctx({ lastValue: 100 }));
    expect(d.alert!.value).toBe(80);
    expect(d.alert!.sourceUrl).toBe('u2');
  });
  it('found:false não alerta nem cria baseline', () => {
    const d = decideAlert(tracker(), [{ found: false, evidence: 'nada', confidence: 0.9 }], ctx());
    expect(d.alert).toBeUndefined();
    expect(d.baseline).toBe(false);
  });
  it('cooldown: mesmo achado dentro de 60 min não alerta de novo; após 90 min alerta', () => {
    const base = { lastValue: 100, lastAlertSourceUrl: 'https://loja/a' };
    expect(decideAlert(tracker(), [price(90)], ctx({ ...base, lastAlertAt: '2026-01-02T11:50:00Z' })).alert).toBeUndefined();
    expect(decideAlert(tracker(), [price(90)], ctx({ ...base, lastAlertAt: '2026-01-02T10:30:00Z' })).alert).toBeDefined();
  });
});

describe('decideAlert (notícias)', () => {
  const news = (title: string, url: string): Finding => ({ found: true, title, sourceUrl: url, evidence: 'e', confidence: 0.9 });
  const t = tracker({ kind: 'news', name: 'Notícias X', alertCondition: { type: 'new_items' } });
  it('alerta só com itens novos e lista os títulos', () => {
    const seen = new Set(['u1']);
    const d = decideAlert(t, [news('Velha', 'u1'), news('Nova', 'u2')], ctx({ isNew: (k) => !seen.has(k) }));
    expect(d.alert!.text).toContain('Nova');
    expect(d.alert!.text).not.toContain('Velha');
  });
  it('sem itens novos não alerta', () => {
    expect(decideAlert(t, [news('Velha', 'u1')], ctx({ isNew: () => false })).alert).toBeUndefined();
  });
});

describe('parsePrice', () => {
  it('interpreta formatos comuns', () => {
    expect(parsePrice('R$ 1.999,90')).toBe(1999.9);
    expect(parsePrice('1,999.90')).toBe(1999.9);
    expect(parsePrice('1999.9')).toBe(1999.9);
    expect(parsePrice(2499)).toBe(2499);
  });
  it('rejeita lixo e não positivos', () => {
    expect(parsePrice('grátis')).toBeUndefined();
    expect(parsePrice(-3)).toBeUndefined();
    expect(parsePrice(0)).toBeUndefined();
    expect(parsePrice(NaN)).toBeUndefined();
    expect(parsePrice(undefined)).toBeUndefined();
  });
});
