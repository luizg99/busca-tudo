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
  /** Só vale oferta de loja confiável (lista em Configurações); site desconhecido só entra se levar a uma loja confiável. */
  onlyTrusted: boolean;
}

export type NewTracker = Omit<Tracker, 'id' | 'status' | 'createdAt' | 'onlyTrusted'> & { onlyTrusted?: boolean };

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
  /** Loja que vende (pode diferir do site onde a oferta foi vista, ex.: blog de cupom). */
  store?: string;
  /** Link final da loja (ou link de saída do site) para conferir que leva a uma loja confiável. */
  storeUrl?: string;
  /** Cupom e condições, se a oferta depender de um. */
  coupon?: string;
  /** Preenchido pelo app: domínio do site desconhecido por onde uma loja confiável foi encontrada. */
  via?: string;
  /** Preenchido pelo app: motivo de a oferta ter sido ignorada (loja desconhecida). */
  ignoredReason?: string;
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
  const ot = (t as { onlyTrusted?: unknown }).onlyTrusted;
  if (ot !== undefined && typeof ot !== 'boolean') errors.push('"Só lojas confiáveis" deve ser verdadeiro ou falso.');
  if (t.alertCondition.type === 'below_value' && !(t.alertCondition.value > 0)) {
    errors.push('O valor de alerta deve ser maior que zero.');
  }
  return errors;
}
