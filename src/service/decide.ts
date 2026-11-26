import type { Finding, Tracker } from '../shared/types';

export const MIN_CONFIDENCE = 0.6;
export const ALERT_COOLDOWN_MINUTES = 60;

export interface DecisionContext {
  lastValue?: number;
  /** Valor do último alerta enviado (qualquer loja), para suprimir oscilação. */
  lastAlertValue?: number;
  /** Retorna true se o item ainda não foi visto (e o marca como visto). */
  isNew(key: string): boolean;
  lastAlertAt?: string;
  lastAlertSourceUrl?: string;
  now: string;
}

export interface Decision {
  baseline: boolean;
  alert?: { text: string; sourceUrl?: string; value?: number };
  ignored: string[];
}

export const OSCILATION_WINDOW_HOURS = 24;

const isBrl = (f: Finding): boolean => !f.currency || f.currency.toUpperCase() === 'BRL';

/** Achado de preço que pode servir de referência: encontrado, confiável e em BRL. */
export function isReliablePrice(f: Finding): boolean {
  return f.found && !f.ignoredReason && typeof f.value === 'number' && f.value > 0 && f.confidence >= MIN_CONFIDENCE && isBrl(f);
}

/** Descrição curta do pagamento: "à vista (Pix)", "só parcelado (10x sem juros)" ou undefined se não se sabe. */
export function paymentLabel(f: Pick<Finding, 'payment' | 'paymentNote'>): string | undefined {
  if (!f.payment) return undefined;
  const base = f.payment === 'vista' ? 'à vista' : 'só parcelado';
  return f.paymentNote ? `${base} (${f.paymentNote})` : base;
}

/** A oferta confiável de menor valor de uma verificação. */
export function bestReliable(findings: Finding[]): Finding | undefined {
  return findings.filter(isReliablePrice).reduce<Finding | undefined>((m, f) => (!m || (f.value as number) < (m.value as number) ? f : m), undefined);
}

/** Menor valor confiável de uma verificação (usado como "último valor" e nas estatísticas). */
export function reliableValue(findings: Finding[]): number | undefined {
  const vals = findings.filter(isReliablePrice).map((f) => f.value as number);
  return vals.length ? Math.min(...vals) : undefined;
}

export function parsePrice(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s) || s.includes('-')) return undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let decimalSep: '.' | ',' | undefined;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const count = sep === ',' ? commas : dots;
    const after = s.length - 1 - (sep === ',' ? lastComma : lastDot);
    // um único separador seguido de 1-2 dígitos é decimal; 3 dígitos ou repetido é milhar
    if (count === 1 && after <= 2) decimalSep = sep;
  }
  if (decimalSep) {
    const thousands = decimalSep === '.' ? /,/g : /\./g;
    s = s.replace(thousands, '');
    if (decimalSep === ',') s = s.replace(',', '.');
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const brl = (n: number, currency?: string): string => {
  const prefix = !currency || currency.toUpperCase() === 'BRL' ? 'R$' : currency.toUpperCase();
  return `${prefix} ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function withinCooldown(ctx: DecisionContext, sourceUrl: string | undefined): boolean {
  if (!ctx.lastAlertAt) return false;
  if (ctx.lastAlertSourceUrl !== sourceUrl) return false;
  const elapsedMin = (Date.parse(ctx.now) - Date.parse(ctx.lastAlertAt)) / 60000;
  return elapsedMin < ALERT_COOLDOWN_MINUTES;
}

/** Mesmo valor (ou maior) que o último alertado, em qualquer loja, dentro da janela: é ruído de oscilação. */
function repeatsLastAlert(ctx: DecisionContext, value: number): boolean {
  if (!ctx.lastAlertAt || ctx.lastAlertValue === undefined) return false;
  const elapsedH = (Date.parse(ctx.now) - Date.parse(ctx.lastAlertAt)) / 3600000;
  return elapsedH < OSCILATION_WINDOW_HOURS && value >= ctx.lastAlertValue;
}

export function decideAlert(t: Tracker, findings: Finding[], ctx: DecisionContext): Decision {
  const ignored: string[] = [];
  const reliable: Finding[] = [];
  for (const f of findings) {
    if (!f.found || f.ignoredReason) continue; // oferta de loja desconhecida já foi descartada (e registrada) antes
    if (typeof f.value === 'number' && !isBrl(f)) {
      ignored.push(`moeda ${f.currency} ignorada (só BRL é comparado): ${f.title ?? f.sourceUrl ?? f.evidence}`);
      continue;
    }
    if (f.confidence < MIN_CONFIDENCE) {
      ignored.push(`confiança baixa (${f.confidence}): ${f.title ?? f.sourceUrl ?? f.evidence}`);
      continue;
    }
    reliable.push(f);
  }

  if (t.alertCondition.type === 'new_items') {
    const fresh = reliable.filter((f) => ctx.isNew(f.sourceUrl ?? f.title ?? f.evidence));
    if (fresh.length === 0) return { baseline: false, ignored };
    const lines = fresh.map((f) => `• ${f.title ?? f.evidence}${f.sourceUrl ? `\n  ${f.sourceUrl}` : ''}`);
    return { baseline: false, ignored, alert: { text: `📰 ${t.name}: ${fresh.length} novidade(s)\n${lines.join('\n')}`, sourceUrl: fresh[0].sourceUrl } };
  }

  const priced = reliable.filter((f) => typeof f.value === 'number' && f.value > 0);
  if (priced.length === 0) return { baseline: false, ignored };
  const best = priced.reduce((a, b) => ((b.value as number) < (a.value as number) ? b : a));
  const value = best.value as number;

  let hit = false;
  if (t.alertCondition.type === 'below_value') {
    // só alerta ao cruzar o limite (ou na primeira vez), não a cada verificação enquanto estiver abaixo
    const limit = t.alertCondition.value;
    hit = value < limit && (ctx.lastValue === undefined || ctx.lastValue >= limit);
  } else {
    if (ctx.lastValue === undefined) return { baseline: true, ignored };
    hit = value < ctx.lastValue;
  }
  if (!hit || withinCooldown(ctx, best.sourceUrl) || repeatsLastAlert(ctx, value)) return { baseline: false, ignored };

  const header =
    t.alertCondition.type === 'below_value'
      ? `📉 ${t.name}: o preço ficou abaixo de ${brl(t.alertCondition.value)}!`
      : `📉 ${t.name}: achei um preço menor que na última consulta!`;
  const lines = [header, `Menor achado: ${brl(value, best.currency)}${best.title ? ` (${best.title})` : ''}`];
  if (ctx.lastValue !== undefined && value < ctx.lastValue) {
    const diff = ctx.lastValue - value;
    const pct = ((diff / ctx.lastValue) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    lines.push(`Última consulta: ${brl(ctx.lastValue, best.currency)} (queda de ${brl(diff, best.currency)} · ${pct}%)`);
  }
  // loja que vende e onde a oferta foi achada (ex.: "Amazon · achado em ofertinha.com.br") e o cupom, se houver
  if (best.store || best.via) lines.push(`Loja: ${best.store ?? best.via}${best.via ? ` · achado em ${best.via}` : ''}`);
  if (best.viaUrl) lines.push(`Achado em: ${best.viaUrl}`);
  if (best.claimedValue !== undefined) lines.push(`O site da oferta informava ${brl(best.claimedValue, best.currency)}; vale o preço lido na loja.`);
  if (best.unverified) lines.push('⚠️ Preço não conferido na página da loja (informado pela busca).');
  const pay = paymentLabel(best);
  if (pay) lines.push(`Pagamento: ${pay}`);
  if (best.coupon) lines.push(`Cupom: ${best.coupon}`);
  if (best.storeUrl && best.storeUrl !== best.sourceUrl) lines.push(`Comprar: ${best.storeUrl}`);
  if (best.sourceUrl) lines.push(best.sourceUrl);
  const text = lines.join('\n');
  return { baseline: false, ignored, alert: { text, sourceUrl: best.sourceUrl, value } };
}
