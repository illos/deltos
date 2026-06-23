import { Hono } from 'hono';
import type { AppEnv, AppContext } from '../context.js';
import { apiError, NON_PROD_ENVIRONMENTS } from '../http.js';
import { resolvePrincipal } from '../auth.js';

/** Max HTML bytes to stream from the target — we only need the <head>. */
const MAX_HTML_BYTES = 256 * 1024;
/** Per-hop fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 5_000;
/** Maximum redirects to follow manually before blocking (each hop re-checked for SSRF). */
const MAX_REDIRECTS = 5;
/** KV cache TTL in seconds (1 hour). */
const CACHE_TTL_SECONDS = 3_600;

/**
 * Parsed link-preview metadata returned by GET /api/unfurl.
 *
 * ⚠️ SECURITY NOTE — these fields are ATTACKER-CONTROLLED: og:title / description / siteName
 * are verbatim text from the target site and MUST be rendered as plain text by the client,
 * NEVER as HTML. The image / favicon fields are URL strings whose scheme has been validated
 * (http/https only), but the client MUST NOT auto-fetch them in a way that re-opens an SSRF
 * channel — they should only be loaded by the browser as passive image src attributes.
 */
export interface UnfurlResult {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
}

export const unfurl = new Hono<AppEnv>();

unfurl.get('/', async (c: AppContext) => {
  // 1. Authenticate. Same F13 fail-closed tripwire as the transcribe route: the unverified
  //    dev-only principal is refused outside an explicit non-prod environment. No un-authed
  //    caller reaches any fetch (which is paid egress).
  //
  //    DEFERRED — per-account durable throttle (same class as transcribe §6 ruling): KV cache
  //    covers re-fetch of the SAME url, but unique-URL flooding is unthrottled at this layer.
  //    HARD-required before >1 user; low risk at solo-dogfood scale.
  const principal = await resolvePrincipal(c);
  if (
    principal.verification.method === 'unverified' &&
    !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')
  ) {
    return apiError(c, 401, 'unauthorized', 'unfurl requires an authenticated session');
  }

  // 2. URL param — required, must be a parseable absolute URL.
  const rawUrl = c.req.query('url');
  if (!rawUrl) {
    return apiError(c, 400, 'invalid_request', 'missing required query param: url');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return apiError(c, 400, 'invalid_request', 'url is not a valid absolute URL');
  }

  // 3. SSRF guard. This is the headline security control for this route — the guard
  //    canonicalizes alternate IP encodings (decimal/octal/hex integers, IPv4-mapped IPv6)
  //    and blocks private/internal targets before any network egress. See ssrfGuard below.
  const ssrfErr = ssrfGuard(parsed);
  if (ssrfErr) {
    return apiError(c, 400, 'invalid_url', ssrfErr);
  }

  // 4. KV cache lookup (gracefully skipped when UNFURL_CACHE is unbound).
  const cacheKey = toCacheKey(parsed);
  if (c.env.UNFURL_CACHE) {
    const cached = (await c.env.UNFURL_CACHE.get(cacheKey, 'json')) as UnfurlResult | null;
    if (cached) return c.json(cached);
  }

  // 5. Fetch, following redirects manually so every hop is re-checked for SSRF.
  let html: string;
  let finalUrl: string;
  try {
    ({ html, finalUrl } = await fetchWithSsrfGuard(parsed.href));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('ssrf:')) {
      return apiError(c, 400, 'invalid_url', msg.slice(5).trim());
    }
    return apiError(c, 502, 'fetch_failed', 'could not retrieve the target URL');
  }

  // 6. Parse og: / standard meta tags.
  const result = parseMetadata(html, finalUrl);

  // 7. Cache and return.
  if (c.env.UNFURL_CACHE) {
    await c.env.UNFURL_CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  }
  return c.json(result);
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable error string if the URL should be blocked, null if safe.
 *
 * Controls built in (all REQUIRED before any egress):
 *   1. Scheme allowlist — http/https only; file/data/javascript/gopher/ftp etc. all blocked.
 *   2. Private host block — RFC-1918, loopback (127/8), link-local incl. cloud-metadata
 *      (169.254.169.254), IPv6 loopback/ULA/link-local. IP literals in ALL encodings are
 *      canonicalized before checking — decimal int (2130706433), octal (0177.0.0.1), and hex
 *      (0x7f.0.0.1) all resolve to 127.0.0.1 before the private-range test runs.
 *   3. Redirect re-validation — fetchWithSsrfGuard calls ssrfGuard on EVERY Location before
 *      following (redirect:'manual' + explicit loop).
 *
 * RESIDUAL RISK — DNS rebinding (noted for secSys): Workers cannot pre-resolve DNS before
 * fetch, so a public hostname that rebinds to a private IP between this check and the actual
 * egress request is not fully preventable in this runtime. The Cloudflare Workers egress
 * network provides defense-in-depth (generally cannot reach RFC-1918/metadata from the
 * Workers runtime), but we do not rely on that as the primary control. The static controls
 * above (literal-IP block + scheme allowlist + redirect re-validation) cover the main attack
 * surface; the residual dynamic rebind-to-unintended-public-host risk is accepted and mitigated
 * by never returning the raw response body.
 */
export function ssrfGuard(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme '${url.protocol.replace(/:$/, '')}' is not allowed; only http and https are permitted`;
  }

  const host = url.hostname.toLowerCase();

  // Try to canonicalize numeric IP forms (handles decimal/octal/hex alt-encodings that the URL
  // parser might not have normalized yet, and plain dotted-quad that it already has).
  const canonicalIp = normalizeToIpv4(host);
  if (canonicalIp !== null) {
    if (isPrivateIpv4(canonicalIp)) {
      return `host '${host}' is a private or internal address`;
    }
    return null; // Public IPv4 literal — allow
  }

  // IPv6 literal (URL.hostname wraps in brackets: [::1]).
  const rawHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (rawHost.includes(':')) {
    if (isPrivateIpv6(rawHost)) {
      return `host '${host}' is a private or internal IPv6 address`;
    }
    return null; // Public IPv6 — allow
  }

  // Hostname form.
  if (isPrivateHostname(host)) {
    return `host '${host}' is a private or internal hostname`;
  }
  return null;
}

/**
 * Canonicalize any numeric IPv4 representation to dotted-quad.
 * Handles the WHATWG URL spec's alternate forms that are frequently used to bypass naive
 * denylist checks:
 *   - dotted-quad (pass-through):    127.0.0.1
 *   - single decimal integer:         2130706433    → 127.0.0.1
 *   - hex-prefixed parts:             0x7f.0.0.1    → 127.0.0.1
 *   - octal-prefixed parts:           0177.0.0.1    → 127.0.0.1
 *   - two/three-part forms:           127.1         → 127.0.0.1
 * Returns null when the input is not a numeric IPv4 form (i.e. it's a hostname or IPv6).
 */
function normalizeToIpv4(host: string): string | null {
  // Quick exit: if it contains non-numeric, non-dot characters it's a hostname or IPv6.
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;

  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      n = parseInt(part, 16);
    } else if (part.length > 1 && part.startsWith('0')) {
      n = parseInt(part, 8); // octal
    } else if (/^\d+$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  // Validate bounds and assemble a 32-bit integer (WHATWG IPv4 multi-part rules).
  // Destructure first so TypeScript can narrow from undefined after each null guard.
  // Note: JS bitwise ops work on signed int32; use >>> (unsigned right shift) for extraction.
  const [n0, n1, n2, n3] = nums;
  if (n0 === undefined) return null;
  let ip32: number;
  if (nums.length === 4) {
    if (n1 === undefined || n2 === undefined || n3 === undefined) return null;
    if (n0 > 255 || n1 > 255 || n2 > 255 || n3 > 255) return null;
    ip32 = (n0 << 24) | (n1 << 16) | (n2 << 8) | n3;
  } else if (nums.length === 3) {
    if (n1 === undefined || n2 === undefined) return null;
    if (n0 > 255 || n1 > 255 || n2 > 0xffff) return null;
    ip32 = (n0 << 24) | (n1 << 16) | n2;
  } else if (nums.length === 2) {
    if (n1 === undefined) return null;
    if (n0 > 255 || n1 > 0xffffff) return null;
    ip32 = (n0 << 24) | n1;
  } else {
    // Single-part: full 32-bit integer
    if (n0 > 0xffffffff) return null;
    ip32 = n0;
  }

  const a = (ip32 >>> 24) & 0xff;
  const b = (ip32 >>> 16) & 0xff;
  const c = (ip32 >>> 8) & 0xff;
  const d = ip32 & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv4(dotted: string): boolean {
  const m = dotted.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  // Non-null assertions safe: the regex guarantees groups 1 and 2 are captured when it matches.
  const [a, b] = [+m[1]!, +m[2]!];
  return (
    a === 127 || // 127.0.0.0/8 — loopback
    a === 10 || // 10.0.0.0/8   — RFC-1918
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12  — RFC-1918
    (a === 192 && b === 168) || // 192.168.0.0/16 — RFC-1918
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local incl. cloud metadata
    a === 0 // 0.0.0.0/8
  );
}

/**
 * Check whether a compressed IPv6 address string is in a private/reserved range.
 *
 * FIX #71: the previous version used a dotted-quad regex for IPv4-mapped detection
 * (::ffff:\d+\.\d+\.\d+\.\d+), but new URL() serializes IPv4-mapped IPv6 to HEX
 * (e.g. ::ffff:7f00:1 for 127.0.0.1, ::ffff:a9fe:a9fe for 169.254.169.254). The
 * dotted regex therefore NEVER matched real URL-parser output — the check was dead
 * code, leaving all v4-mapped addresses (including cloud metadata) passable.
 *
 * Fix: fully expand the address to 8 uint16 hextets via expandIpv6, then do numeric
 * range checks. This handles both compressed (::ffff:7f00:1) and full forms, catches
 * NAT64 (64:ff9b::/96), and is immune to formatting variations.
 *
 * REGRESSION TEST METHODOLOGY (secSys #71): always drive SSRF test inputs through
 * new URL('http://[<addr>]/') first, then pass .hostname to ssrfGuard — the URL
 * parser canonicalizes to hex, so idealized dotted strings false-pass tests.
 */
function isPrivateIpv6(raw: string): boolean {
  const groups = expandIpv6(raw.toLowerCase());
  if (groups === null) return false; // not parseable — let network layer handle

  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g2 = groups[2]!;
  const g3 = groups[3]!;
  const g4 = groups[4]!;
  const g5 = groups[5]!;
  const g6 = groups[6]!;
  const g7 = groups[7]!;

  // Loopback ::1 and unspecified ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  }
  // fc00::/7 unique-local (ULA)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // ::ffff:0:0/96 IPv4-mapped — last two hextets encode the IPv4 address.
  // new URL() produces the hex form (::ffff:7f00:1), not the dotted form
  // (::ffff:127.0.0.1) — the old dotted regex was dead code against real URL output.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }

  // 64:ff9b::/96 NAT64 — translates IPv6 requests to IPv4 behind a NAT64 gateway;
  // the embedded IPv4 is in the last two hextets.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

/**
 * Expand a compressed IPv6 address to exactly 8 uint16 groups.
 * Handles :: compression. Returns null for invalid input.
 * Does NOT handle IPv4-in-IPv6 dotted notation (the WHATWG URL parser never emits it).
 */
function expandIpv6(addr: string): number[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null; // more than one :: is invalid IPv6

  const parseGroups = (s: string): number[] | null => {
    if (!s) return [];
    const parts = s.split(':');
    const parsed = parts.map((h) => parseInt(h, 16));
    if (parsed.some((v) => !Number.isFinite(v) || v < 0 || v > 0xffff)) return null;
    return parsed;
  };

  if (halves.length === 2) {
    const leftStr = halves[0] ?? '';
    const rightStr = halves[1] ?? '';
    const left = parseGroups(leftStr);
    const right = parseGroups(rightStr);
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    const expanded = [...left, ...Array.from<number>({ length: fill }).fill(0), ...right];
    return expanded.length === 8 ? expanded : null;
  } else {
    // No :: — must be exactly 8 colon-separated groups
    const parts = addr.split(':');
    if (parts.length !== 8) return null;
    const parsed = parts.map((h) => parseInt(h, 16));
    if (parsed.some((v) => !Number.isFinite(v) || v < 0 || v > 0xffff)) return null;
    return parsed;
  }
}

function isPrivateHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain') ||
    host.endsWith('.localhost')
  );
}

// ---------------------------------------------------------------------------
// Fetch with per-hop SSRF re-validation
// ---------------------------------------------------------------------------

async function fetchWithSsrfGuard(startUrl: string): Promise<{ html: string; finalUrl: string }> {
  let url = startUrl;
  let hopsLeft = MAX_REDIRECTS;

  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Deltos/1 (+unfurl)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('fetch timed out');
      }
      throw err;
    }

    // Manual redirect following — re-check every Location for SSRF before following.
    if (response.status >= 300 && response.status < 400) {
      if (hopsLeft <= 0) throw new Error('ssrf: too many redirects');
      hopsLeft--;
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect with no Location header');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new Error('ssrf: invalid redirect URL');
      }
      const err = ssrfGuard(next);
      if (err) throw new Error(`ssrf: redirect target blocked — ${err}`);
      url = next.href;
      continue;
    }

    if (!response.ok) throw new Error(`upstream returned ${response.status}`);

    // Content-Type gate: only parse HTML; never stream binary/audio/video into the buffer.
    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      throw new Error('target did not return an HTML response');
    }

    const html = await readCapped(response, MAX_HTML_BYTES);
    return { html, finalUrl: url };
  }
}

/** Stream up to maxBytes of response body, stopping early after </head>. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      const slice =
        bytesRead > maxBytes ? value.slice(0, value.byteLength - (bytesRead - maxBytes)) : value;
      parts.push(decoder.decode(slice, { stream: true }));
      if (bytesRead >= maxBytes) break;
      // Stop once the head section is complete — we don't need the body text.
      const joined = parts.join('');
      if (joined.includes('</head>') || joined.includes('<body')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Metadata parser
// ---------------------------------------------------------------------------

/**
 * Parse og: and standard meta tags from a fragment of HTML.
 * Returned string fields (title/description/siteName) are attacker-controlled plain text —
 * see UnfurlResult JSDoc for the client rendering contract.
 */
export function parseMetadata(html: string, pageUrl: string): UnfurlResult {
  const title = getMetaProperty(html, 'og:title') ?? getTitleTag(html);
  const description =
    getMetaProperty(html, 'og:description') ?? getMetaName(html, 'description');
  const image = safeImageUrl(getMetaProperty(html, 'og:image'), pageUrl);
  const siteName = getMetaProperty(html, 'og:site_name');

  const rawFavicon = getLinkHref(html, 'icon') ?? getLinkHref(html, 'shortcut icon');
  const base = new URL(pageUrl);
  const favicon = rawFavicon
    ? safeImageUrl(rawFavicon, pageUrl) ?? `${base.protocol}//${base.host}/favicon.ico`
    : `${base.protocol}//${base.host}/favicon.ico`;

  return { url: pageUrl, title, description, image, favicon, siteName };
}

function getMetaProperty(html: string, prop: string): string | null {
  const esc = escapeRe(prop);
  const m =
    html.match(
      new RegExp(
        `<meta[^>]+property=["']${esc}["'][^>]+content=["']([^"']*?)["']`,
        'i',
      ),
    ) ??
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']${esc}["']`,
        'i',
      ),
    );
  return m ? decodeEntities(m[1]!) : null; // non-null: group 1 always captured when regex matches
}

function getMetaName(html: string, name: string): string | null {
  const esc = escapeRe(name);
  const m =
    html.match(
      new RegExp(`<meta[^>]+name=["']${esc}["'][^>]+content=["']([^"']*?)["']`, 'i'),
    ) ??
    html.match(
      new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']${esc}["']`, 'i'),
    );
  return m ? decodeEntities(m[1]!) : null; // non-null: group 1 always captured when regex matches
}

function getTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]!.trim()) : null; // non-null: group 1 always captured
}

function getLinkHref(html: string, rel: string): string | null {
  const esc = escapeRe(rel);
  const m =
    html.match(
      new RegExp(`<link[^>]+rel=["']${esc}["'][^>]+href=["']([^"']*?)["']`, 'i'),
    ) ??
    html.match(
      new RegExp(`<link[^>]+href=["']([^"']*?)["'][^>]+rel=["']${esc}["']`, 'i'),
    );
  return m ? m[1]! : null; // non-null: group 1 always captured when regex matches
}

/** Resolve href to absolute and validate the scheme — returns null if not http/https. */
function safeImageUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCacheKey(url: URL): string {
  const u = new URL(url.href);
  u.hash = ''; // strip fragment — two URLs differing only by # are the same resource
  return u.href;
}
