// URL safety helpers. No network access here; pure normalisation only.

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function normaliseHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

function ipv4Parts(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (first.startsWith('fc') || first.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(first)) return true;
  return false;
}

export function isPrivateHost(hostname) {
  const host = normaliseHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const v4 = ipv4Parts(host);
  if (v4) return isPrivateIpv4(v4);
  return isPrivateIpv6(host);
}

function parseHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (isPrivateHost(url.hostname)) return null;
  url.hash = '';
  return url;
}

/** Normalise a user-supplied HTTP(S) link. Returns null when unsafe or invalid. */
export function normalizeHttpUrl(raw) {
  return parseHttpUrl(raw)?.toString() ?? null;
}

/** Product watch URLs are HTTPS-only. Returns null when unsafe or invalid. */
export function normalizeHttpsUrl(raw) {
  const url = parseHttpUrl(raw);
  if (!url || url.protocol !== 'https:') return null;
  if (url.hostname.startsWith('[')) return null; // bracketed IPv6 literals are not supported
  return url.toString();
}

/** Permission pattern for exactly one origin (host), excluding path and query. */
export function originPatternForUrl(raw) {
  const url = raw instanceof URL ? raw : parseHttpUrl(raw);
  if (!url) return null;
  return `${url.protocol}//${url.hostname}/*`;
}

export function hostLabel(raw) {
  const url = raw instanceof URL ? raw : parseHttpUrl(raw);
  if (!url) return 'invalid link';
  return url.hostname.replace(/^www\./, '');
}

export function youtubeSearchUrl(query) {
  const text = String(query ?? '').trim().slice(0, 200);
  if (!text) return null;
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', text);
  return url.toString();
}
