import { lookup } from 'node:dns/promises';

export type FetchResult =
  | { ok: true; html: string }
  | { ok: false; kind: 'blocked' | 'http' | 'timeout' | 'network' | 'invalid'; status?: number; message: string };

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 5;

/** Endereços que não são da internet pública: loopback, redes privadas, link-local (inclui metadados de nuvem). */
export function isPrivateHost(hostRaw: string): boolean {
  const h = hostRaw.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    return h.startsWith('::ffff:') ? isPrivateHost(h.slice(7)) : false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const internal = (): FetchResult => ({ ok: false, kind: 'invalid', message: 'Endereço interno bloqueado (só sites públicos são acessados).' });

/** Decodifica pelos bytes usando o charset do cabeçalho, do <meta> ou UTF-8 (lojas brasileiras ainda usam ISO-8859-1). */
function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = contentType?.match(/charset=["']?([\w.:-]+)/i)?.[1];
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  const label = (fromHeader ?? head.match(/<meta[^>]+charset=["']?([\w.:-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Baixa uma página (HTML) com timeout e limite de tamanho, classificando os erros em português.
 * Recusa endereços internos (inclusive em redirecionamentos e quando o nome resolve para IP interno).
 * `allowedHosts` existe para os testes locais.
 */
export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; allowedHosts?: string[] } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const allowed = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!/^https?:\/\//i.test(current)) return { ok: false, kind: 'invalid', message: 'Endereço inválido (só http/https).' };
      const host = new URL(current).hostname.toLowerCase();
      if (!allowed.has(host)) {
        if (isPrivateHost(host)) return internal();
        if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
          const addrs = await lookup(host, { all: true }).catch(() => []);
          if (addrs.some((a) => isPrivateHost(a.address))) return internal();
        }
      }

      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        return { ok: false, kind: 'blocked', status: res.status, message: `O site bloqueou o acesso automático (HTTP ${res.status}).` };
      }
      if (!res.ok) return { ok: false, kind: 'http', status: res.status, message: `O site respondeu com erro HTTP ${res.status}.` };

      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          if (bytes >= maxBytes) { await reader.cancel().catch(() => undefined); break; }
        }
      }
      const all = Buffer.concat(chunks).subarray(0, maxBytes);
      return { ok: true, html: decodeBody(all, res.headers.get('content-type')) };
    }
    return { ok: false, kind: 'http', message: 'O site fez redirecionamentos demais.' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, kind: 'timeout', message: `O site demorou mais de ${Math.round(timeoutMs / 1000)} s para responder.` };
    return { ok: false, kind: 'network', message: `Falha de conexão com o site (${(e as Error).message}).` };
  } finally {
    clearTimeout(timer);
  }
}
