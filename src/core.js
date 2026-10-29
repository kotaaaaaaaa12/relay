export class RelayError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') {
    super(message); this.status = status; this.code = code;
  }
}

export const PART_SIZE = 8 * 1024 * 1024;
export function limits(env = {}) {
  return {
    maxBytes: bounded(env.MAX_FILE_BYTES, 5 * 1024 ** 3, 1, 64 * 1024 ** 3),
    retention: bounded(env.RETENTION_HOURS, 24, 1, 168) * 3600000,
    maxActive: bounded(env.MAX_ACTIVE_PER_DEVICE, 2, 1, 5),
    maxGlobalActive: bounded(env.MAX_GLOBAL_ACTIVE, 4, 1, 20),
    maxStoredBytes: bounded(env.MAX_STORED_BYTES, 20 * 1024 ** 3, 1, 1024 ** 4),
    maxJobs: 100,
  };
}
function bounded(value, fallback, min, max) {
  const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}
export function isPublicIPv4(host) {
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export function isPublicAddress(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) {
    // Accept only global unicast IPv6, excluding documentation and transition networks.
    return /^[23][0-9a-f]{0,3}:/.test(h) && !/^(2001:(db8|0|10|20):|2002:)/.test(h);
  }
  return isPublicIPv4(h);
}
export function validateURL(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new RelayError('Enter a valid file URL.');
  let u; try { u = new URL(input.trim()); } catch { throw new RelayError('Enter a valid file URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new RelayError('Only HTTP and HTTPS URLs are supported.');
  if (u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new RelayError('Credentials and custom ports are not supported.');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (!isPublicAddress(h)) throw new RelayError('This network address is not allowed.');
  } else if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(h)) {
    throw new RelayError('Use a public file URL.');
  }
  u.hostname = h; u.hash = ''; return u;
}
export async function checkDNS(u, fetcher = fetch) {
  if (u.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return;
  const results = await Promise.all(['A','AAAA'].map(async type => {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', u.hostname); endpoint.searchParams.set('type', type);
    const r = await fetcher(endpoint, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new RelayError('The source hostname could not be checked.', 502, 'DNS_FAILED');
    const d = await r.json();
    if (![0,3].includes(d.Status)) throw new RelayError('The source hostname could not be resolved.', 502, 'DNS_FAILED');
    return (d.Answer || []).filter(x => x.type === 1 || x.type === 28).map(x => x.data);
  }));
  const ips = results.flat();
  if (!ips.length || ips.some(ip => !isPublicAddress(ip))) throw new RelayError('This source does not resolve to a public network address.');
}
export async function safeFetch(input, init = {}, fetcher = fetch) {
  let u = validateURL(String(input));
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 30000);
  try {
    for (let i = 0; i <= 5; i++) {
      await checkDNS(u, fetcher);
      const r = await fetcher(u.href, { ...init, redirect: 'manual', signal: controller.signal,
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Relay/1.0', ...(init.headers || {}) } });
      if (![301,302,303,307,308].includes(r.status)) {
        clearTimeout(timer);
        return { response: r, url: u.href, controller };
      }
      const location = r.headers.get('location'); await r.body?.cancel();
      if (!location || i === 5) throw new RelayError('The source has too many redirects.', 502, 'REDIRECT_FAILED');
      u = validateURL(new URL(location, u).href);
    }
  } catch (e) { clearTimeout(timer); controller.abort(); throw e; }
}
export function filenameFrom(headers, url) {
  let name = '';
  const disposition = headers.get('content-disposition') || '';
  const extended = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (extended) { try { name = decodeURIComponent(extended[1].trim()); } catch {} }
  if (!name) name = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1] || disposition.match(/filename\s*=\s*([^;]+)/i)?.[1] || '';
  if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download'); } catch { name = 'download'; } }
  return cleanName(name);
}
export function cleanName(name) {
  const n = String(name).replace(/[\x00-\x1f\x7f/\\<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').trim().replace(/^\.+/, '').slice(0,180);
  return n || 'download';
}
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size < 1) throw new RelayError('The requested byte range is not available.', 416, 'RANGE_NOT_SATISFIABLE');
  let start, end;
  if (!m[1]) { const suffix = Number(m[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RelayError('Invalid byte range.',416); start = Math.max(0, size-suffix); end = size-1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size-1) : size-1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new RelayError('Invalid byte range.',416);
  return { offset: start, length: end-start+1 };
}
export async function sha256(value) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
}
export function token() { return crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-',''); }
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra } });
}
export async function readBody(request) {
  const reader = request.body?.getReader(); if (!reader) return {};
  const decoder = new TextDecoder(); let out = '', size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
    if (size > 12000) { await reader.cancel(); throw new RelayError('The request is too large.',413); } out += decoder.decode(value,{stream:true}); }
  out += decoder.decode(); try { return JSON.parse(out); } catch { throw new RelayError('Invalid JSON request.'); }
}
