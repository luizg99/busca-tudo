export type TrackerKind = 'price' | 'news' | 'generic';

export type AlertCondition =
  | { type: 'below_last' }
  | { type: 'below_value'; value: number }
  | { type: 'new_items' };

export interface Tracker {
  id: number;
  name: string;
  kind: TrackerKind;
  goal: string;
  include: string[];
  exclude: string[];
  intervalMinutes: number;
  alertCondition: AlertCondition;
  digest: 'none' | 'daily' | 'weekly';
  status: 'active' | 'paused';
  createdAt: string;
}

export type NewTracker = Omit<Tracker, 'id' | 'status' | 'createdAt'>;

export interface Finding {
  found: boolean;
  value?: number;
  currency?: string;
  title?: string;
  sourceUrl?: string;
  evidence: string;
  /** 0..1 */
  confidence: number;
  /** Regex (1 grupo de captura) que lê este preço no texto da página; sugerida pela IA na descoberta. */
  priceRegex?: string;
}

/** Como ler o preço de uma página sem IA: regex com 1 grupo de captura sobre o texto visível, ou dados estruturados. */
export type PriceRule =
  /** `genericOk`: no aprendizado os dados estruturados da página também reproduziram o preço (então podem servir de reserva). */
  | { type: 'regex'; pattern: string; genericOk?: boolean }
  | { type: 'generic' };
export type ReadMethod = 'rule' | 'generic' | 'ai';
export type CheckMode = 'routine' | 'discovery' | 'fallback';
export type SourceStatus = 'ok' | 'failing' | 'unreadable';

/** Resultado da leitura de uma fonte (site) numa verificação. */
export interface SourceResult {
  sourceId?: number;
  url: string;
  label?: string;
  ok: boolean;
  method?: ReadMethod;
  value?: number;
  error?: string;
  /** Preço lido mas fora do esperado em relação ao anterior: não é falha da fonte, pede confirmação pela busca completa. */
  suspectValue?: number;
}

export const MIN_INTERVAL_MINUTES = 15;

export function validateNewTracker(t: NewTracker): string[] {
  const errors: string[] = [];
  if (!t.name || !t.name.trim()) errors.push('O nome do acompanhamento é obrigatório.');
  if (!t.goal || !t.goal.trim()) errors.push('O objetivo do acompanhamento é obrigatório.');
  if (!Number.isFinite(t.intervalMinutes) || t.intervalMinutes < MIN_INTERVAL_MINUTES) {
    errors.push(`O intervalo mínimo é de ${MIN_INTERVAL_MINUTES} minutos.`);
  }
  if (t.alertCondition.type === 'below_value' && !(t.alertCondition.value > 0)) {
    errors.push('O valor de alerta deve ser maior que zero.');
  }
  return errors;
}
