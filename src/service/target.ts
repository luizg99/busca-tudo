import type { Db } from './db';

/** Quantos sites/lojas diferentes a busca diária deve tentar reunir (e o app acompanhar o dia todo). */
export const DEFAULT_TARGET_SITES = 15;
export const MIN_TARGET_SITES = 3;
export const MAX_TARGET_SITES = 30;

/** Meta guardada em Configurações; valor ausente ou inválido volta ao padrão. */
export function getTargetSites(db: Db): number {
  const n = Number(db.getSetting('target_sites'));
  return Number.isInteger(n) && n >= MIN_TARGET_SITES && n <= MAX_TARGET_SITES ? n : DEFAULT_TARGET_SITES;
}

export function isValidTargetSites(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_TARGET_SITES && n <= MAX_TARGET_SITES;
}

/**
 * Pesquisas na web que a IA pode usar por busca: cresce com a meta (cerca de 2 a cada 3 sites), mínimo 4, teto 12.
 * Cada pesquisa custa cerca de US$ 0,01.
 */
export function searchBudget(targetSites: number): number {
  return Math.min(12, Math.max(4, Math.ceil((targetSites * 2) / 3)));
}
