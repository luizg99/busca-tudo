import type { Finding, Tracker } from '../shared/types';

export const MIN_CONFIDENCE = 0.6;
export const ALERT_COOLDOWN_MINUTES = 60;

export interface DecisionContext {
  lastValue?: number;
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

export function decideAlert(t: Tracker, findings: Finding[], ctx: DecisionContext): Decision {
  const ignored: string[] = [];
  const reliable: Finding[] = [];
  for (const f of findings) {
    if (!f.found) continue;
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
    hit = value < t.alertCondition.value;
  } else {
    if (ctx.lastValue === undefined) return { baseline: true, ignored };
    hit = value < ctx.lastValue;
  }
  if (!hit || withinCooldown(ctx, best.sourceUrl)) return { baseline: false, ignored };

  const before = ctx.lastValue !== undefined ? ` (antes ${brl(ctx.lastValue, best.currency)})` : '';
  const text = `📉 ${t.name}: ${brl(value, best.currency)}${before}${best.sourceUrl ? `\n${best.sourceUrl}` : ''}`;
  return { baseline: false, ignored, alert: { text, sourceUrl: best.sourceUrl, value } };
}
