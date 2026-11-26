import { describe, it, expect } from 'vitest';
import { validateNewTracker, MIN_INTERVAL_MINUTES, type NewTracker } from '../src/shared/types';

const valid = (): NewTracker => ({
  name: 'PS5',
  kind: 'price',
  goal: 'Menor preço do PS5 novo',
  include: ['PS5 novo'],
  exclude: ['usado'],
  intervalMinutes: 60,
  alertCondition: { type: 'below_last' },
  digest: 'daily',
});

describe('validateNewTracker', () => {
  it('aceita um acompanhamento de preço válido', () => {
    expect(validateNewTracker(valid())).toEqual([]);
  });
  it('rejeita intervalo abaixo de 15 minutos', () => {
    const errs = validateNewTracker({ ...valid(), intervalMinutes: 5 });
    expect(MIN_INTERVAL_MINUTES).toBe(15);
    expect(errs.some((e) => e.includes('15'))).toBe(true);
  });
  it('rejeita below_value com valor <= 0', () => {
    const errs = validateNewTracker({ ...valid(), alertCondition: { type: 'below_value', value: 0 } });
    expect(errs.length).toBeGreaterThan(0);
  });
  it('rejeita nome vazio', () => {
    expect(validateNewTracker({ ...valid(), name: '  ' }).length).toBeGreaterThan(0);
  });
});
