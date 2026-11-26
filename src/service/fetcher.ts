export type FetchResult =
  | { ok: true; html: string }
  | { ok: false; kind: 'blocked' | 'http' | 'timeout' | 'network' | 'invalid'; status?: number; message: string };

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Baixa uma página (HTML) com timeout e limite de tamanho, classificando os erros em português. */
export async function fetchPage(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  if (!/^https?:\/\//i.test(url)) return { ok: false, kind: 'invalid', message: 'Endereço inválido (só http/https).' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9' },
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, kind: 'blocked', status: res.status, message: `O site bloqueou o acesso automático (HTTP ${res.status}).` };
    }
    if (!res.ok) return { ok: false, kind: 'http', status: res.status, message: `O site respondeu com erro HTTP ${res.status}.` };

    // lê só até o limite
    const reader = res.body?.getReader();
    if (!reader) return { ok: true, html: (await res.text()).slice(0, maxBytes) };
    const decoder = new TextDecoder('utf-8');
    let html = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) { await reader.cancel().catch(() => undefined); break; }
    }
    return { ok: true, html: html.slice(0, maxBytes) };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, kind: 'timeout', message: `O site demorou mais de ${Math.round(timeoutMs / 1000)} s para responder.` };
    return { ok: false, kind: 'network', message: `Falha de conexão com o site (${(e as Error).message}).` };
  } finally {
    clearTimeout(timer);
  }
}
