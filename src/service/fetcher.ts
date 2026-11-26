import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

export type FetchResult =
  | { ok: true; html: string }
  | { ok: false; kind: 'blocked' | 'http' | 'timeout' | 'network' | 'invalid'; status?: number; message: string };

export interface ResolvedAddress { address: string; family: number }

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 5;

/** Expande um IPv6 (com "::" e/ou cauda IPv4 decimal) em 8 grupos de 16 bits; undefined se não for IPv6 válido. */
function parseIpv6(h: string): number[] | undefined {
  let s = h;
  const tail = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return undefined;
    s = s.slice(0, s.length - tail[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

/** IPv4 que não é da internet pública: loopback, privadas, link-local, CGNAT, multicast/reservado/broadcast e blocos de documentação. */
function isReservedIpv4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 198 && (b === 18 || b === 19)) || // testes de rede
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF e documentação
    (a === 198 && b === 51 && c === 100) || // documentação
    (a === 203 && b === 0 && c === 113) || // documentação
    a >= 224 // multicast, reservado e broadcast
  );
}

/**
 * Endereços que não são da internet pública. IPv4: faixas reservadas. IPv6: só é aceito o unicast global (2000::/3);
 * IPv4 mapeado (::ffff:) e 6to4 (2002::/16) têm o IPv4 embutido verificado; Teredo e documentação são bloqueados.
 */
export function isPrivateHost(hostRaw: string): boolean {
  const h = hostRaw.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    const g = parseIpv6(h);
    if (!g) return true; // não dá para interpretar: não arrisca
    const v4 = (x: number, y: number) => isReservedIpv4(x >> 8, x & 255, y >> 8);
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
    if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]); // NAT64 (DNS64): 64:ff9b::/96
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo e documentação
    return !(g[0] >= 0x2000 && g[0] <= 0x3fff); // fora de 2000::/3 (inclui ::1, fc00::, fe80::, ff00::, 64:ff9b::, ::a.b.c.d)
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return isReservedIpv4(Number(m[1]), Number(m[2]), Number(m[3]));
}

const internal = (): FetchResult => ({ ok: false, kind: 'invalid', message: 'Endereço interno bloqueado (só sites públicos são acessados).' });
const invalid = (message = 'Endereço inválido (só http/https).'): FetchResult => ({ ok: false, kind: 'invalid', message });

/** Decodifica pelos bytes usando o charset do cabeçalho, do <meta> ou UTF-8 (lojas brasileiras ainda usam ISO-8859-1). */
function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  const fromHeader = contentType?.match(/charset=["']?([\w.:-]+)/i)?.[1];
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  const label = (fromHeader ?? head.match(/<meta[^>]+charset=["']?([\w.:-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Hosts/IPs isentos do bloqueio de endereço interno (existe para os testes locais). */
  allowedHosts?: string[];
  /** IPs resolvidos isentos do bloqueio (testes). */
  allowResolvedHosts?: string[];
  /** Resolvedor de DNS (injetável nos testes). */
  resolver?: (host: string) => Promise<ResolvedAddress[]>;
}

const defaultResolver = async (host: string): Promise<ResolvedAddress[]> =>
  (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family }));

function readBody(stream: Readable, source: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks).subarray(0, maxBytes)); } };
    stream.on('data', (c: Buffer) => {
      chunks.push(c);
      bytes += c.length;
      if (bytes >= maxBytes) { source.destroy(); stream.destroy(); finish(); }
    });
    stream.on('end', finish);
    // fechar sem ter chegado ao fim é conexão interrompida, não página completa
    stream.on('close', () => (finished ? undefined : reject(new Error('A conexão foi interrompida antes do fim da página.'))));
    stream.on('error', (e) => (finished ? undefined : reject(e)));
    source.on('error', (e) => (finished ? undefined : reject(e)));
  });
}

/**
 * Baixa uma página (HTML) com timeout e limite de tamanho, classificando os erros em português.
 * Recusa endereços internos: o IP é validado no momento da conexão (a resolução de DNS é feita por nós e o mesmo IP
 * é usado para conectar, sem janela para DNS rebinding), inclusive em cada redirecionamento.
 */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const allowedHosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const exemptResolved = new Set([...(opts.allowedHosts ?? []), ...(opts.allowResolvedHosts ?? [])].map((h) => h.toLowerCase()));
  const resolver = opts.resolver ?? defaultResolver;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const lookup = (hostname: string, options: { all?: boolean }, cb: (...args: any[]) => void) => {
    resolver(hostname).then(
      (addrs) => {
        // o callback roda exatamente uma vez, mesmo se algo aqui dentro lançar
        if (addrs.length === 0) return cb(Object.assign(new Error(`Não foi possível resolver ${hostname}`), { code: 'ENOTFOUND' }));
        // um nome liberado só isenta endereços de loopback (uso nos testes locais), nunca redes privadas ou metadados de nuvem
        const hostAllowed = allowedHosts.has(hostname.toLowerCase());
        const isLoopback = (addr: string) => /^127\./.test(addr) || addr === '::1';
        if (addrs.some((a) => isPrivateHost(a.address) && !exemptResolved.has(a.address.toLowerCase()) && !(hostAllowed && isLoopback(a.address)))) {
          return cb(Object.assign(new Error('Endereço interno'), { code: 'EINTERNAL' }));
        }
        return options?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
      },
      (e) => cb(e),
    );
  };

  const request = (u: URL) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'GET',
        signal: controller.signal,
        lookup: lookup as any,
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
      }, resolve);
      req.on('error', reject);
      req.end();
    });

  try {
    let current: URL;
    try { current = new URL(url); } catch { return invalid(); }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return invalid();
      const host = current.hostname.toLowerCase();
      if (!allowedHosts.has(host) && isPrivateHost(host)) return internal();

      const res = await request(current);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume(); // descarta o corpo do redirecionamento
        try { current = new URL(location, current); } catch { return invalid('Redirecionamento para um endereço inválido.'); }
        continue;
      }
      if (status === 403 || status === 429) {
        res.resume();
        return { ok: false, kind: 'blocked', status, message: `O site bloqueou o acesso automático (HTTP ${status}).` };
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return { ok: false, kind: 'http', status, message: `O site respondeu com erro HTTP ${status}.` };
      }

      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream: Readable = encoding.includes('gzip') ? res.pipe(zlib.createGunzip())
        : encoding.includes('deflate') ? res.pipe(zlib.createInflate())
        : encoding.includes('br') ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const body = await readBody(stream, res, maxBytes);
      if (controller.signal.aborted) return { ok: false, kind: 'timeout', message: `O site demorou mais de ${Math.round(timeoutMs / 1000)} s para responder.` };
      return { ok: true, html: decodeBody(body, res.headers['content-type']) };
    }
    return { ok: false, kind: 'http', message: 'O site fez redirecionamentos demais.' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EINTERNAL') return internal();
    // o limite de tempo pode estourar no meio do corpo, quando o erro chega como "aborted"/ECONNRESET
    if (controller.signal.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') return { ok: false, kind: 'timeout', message: `O site demorou mais de ${Math.round(timeoutMs / 1000)} s para responder.` };
    return { ok: false, kind: 'network', message: `Falha de conexão com o site (${err.message}).` };
  } finally {
    clearTimeout(timer);
  }
}
