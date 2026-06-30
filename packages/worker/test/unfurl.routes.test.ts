import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { ssrfGuard, parseMetadata } from '../src/routes/unfurl.js';

/**
 * Unfurl route tests (rich-embeds spec §2). The route is server-side link metadata extraction:
 * authenticate → SSRF guard → fetch → parse og: / <title> → KV cache → return JSON.
 *
 * Three test layers:
 *   1. Unit tests of ssrfGuard directly — fast, exhaustive coverage of all IP encoding forms.
 *   2. Unit tests of parseMetadata directly — fast parser coverage.
 *   3. Route-level tests via app.request — auth gate, happy path, redirect SSRF, cache, errors.
 *
 * The global `fetch` is stubbed per-test via vi.stubGlobal so the route never makes real
 * network requests. vi.unstubAllGlobals() in afterEach restores it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const T = 30_000; // generous timeout for the one real-Argon2id test

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0004_password-auth.sql',
  '0005_recovery-established.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T2>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T2 | null;
      },
      async all<T2>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T2[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(stmt._params as never[]));
        return { meta: { rows_written: info.changes } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => {
        const info = raw.prepare(s.sql).run(...(s._params as never[]));
        return { meta: { rows_written: info.changes } };
      });
    },
  } as unknown as D1Database;
}

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const makeEnv = (over: Partial<Env> = {}, raw?: Database.Database): Env =>
  ({
    DB: d1Over(raw ?? freshDb()),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: 'deltos.test',
    AUTH_PEPPER: 'unit-test-pepper',
    TOTP_ENC_KEY: 'unit-test-totp-key',
    ...over,
  }) as unknown as Env;

/** Minimal KV stub backed by a Map, for cache hit/miss testing. */
function stubKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string, opts?: unknown) => {
      const raw = store.get(key) ?? null;
      if (raw === null) return null;
      if (opts === 'json') return JSON.parse(raw);
      return raw;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  };
}

/** Issue a GET /api/unfurl?url=<target> request. */
function getUnfurl(
  env: Env,
  target: string,
  headers: Record<string, string> = {},
) {
  return app.request(
    `/api/unfurl?url=${encodeURIComponent(target)}`,
    { headers },
    env,
  );
}

/** Build a minimal HTML page with og: tags for parse tests. */
function ogHtml(fields: {
  ogTitle?: string;
  ogDesc?: string;
  ogImage?: string;
  ogSite?: string;
  title?: string;
  favicon?: string;
}): string {
  return `<!DOCTYPE html><html><head>
    ${fields.ogTitle ? `<meta property="og:title" content="${fields.ogTitle}" />` : ''}
    ${fields.ogDesc ? `<meta property="og:description" content="${fields.ogDesc}" />` : ''}
    ${fields.ogImage ? `<meta property="og:image" content="${fields.ogImage}" />` : ''}
    ${fields.ogSite ? `<meta property="og:site_name" content="${fields.ogSite}" />` : ''}
    ${fields.favicon ? `<link rel="icon" href="${fields.favicon}" />` : ''}
    ${fields.title ? `<title>${fields.title}</title>` : ''}
  </head><body><p>body text</p></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// ssrfGuard unit tests — exhaustive IP-encoding coverage
// ===========================================================================

describe('ssrfGuard — scheme allowlist', () => {
  it('allows http', () => expect(ssrfGuard(new URL('http://example.com/'))).toBeNull());
  it('allows https', () => expect(ssrfGuard(new URL('https://example.com/'))).toBeNull());
  it('blocks file://', () =>
    expect(ssrfGuard(new URL('file:///etc/passwd'))).toMatch(/scheme/));
  it('blocks ftp://', () =>
    expect(ssrfGuard(new URL('ftp://example.com/'))).toMatch(/scheme/));
});

describe('ssrfGuard — private IPv4 literals (dotted-quad)', () => {
  it('blocks 127.0.0.1 (loopback)', () =>
    expect(ssrfGuard(new URL('http://127.0.0.1/'))).not.toBeNull());
  it('blocks 10.0.0.1 (RFC-1918 /8)', () =>
    expect(ssrfGuard(new URL('http://10.0.0.1/'))).not.toBeNull());
  it('blocks 172.16.0.1 (RFC-1918 /12)', () =>
    expect(ssrfGuard(new URL('http://172.16.0.1/'))).not.toBeNull());
  it('blocks 172.31.255.254 (still RFC-1918 /12)', () =>
    expect(ssrfGuard(new URL('http://172.31.255.254/'))).not.toBeNull());
  it('allows 172.32.0.1 (outside RFC-1918 /12)', () =>
    expect(ssrfGuard(new URL('http://172.32.0.1/'))).toBeNull());
  it('blocks 192.168.1.1 (RFC-1918 /16)', () =>
    expect(ssrfGuard(new URL('http://192.168.1.1/'))).not.toBeNull());
  it('blocks 169.254.169.254 (cloud metadata)', () =>
    expect(ssrfGuard(new URL('http://169.254.169.254/latest/meta-data/'))).not.toBeNull());
  it('blocks 0.0.0.0', () =>
    expect(ssrfGuard(new URL('http://0.0.0.0/'))).not.toBeNull());
  it('allows 8.8.8.8 (public)', () =>
    expect(ssrfGuard(new URL('http://8.8.8.8/'))).toBeNull());
});

describe('ssrfGuard — alternate IP encodings (bypass-class)', () => {
  it('blocks decimal integer 2130706433 (= 127.0.0.1)', () => {
    const url = new URL('http://2130706433/');
    // Note: WHATWG URL parser may canonicalize to 127.0.0.1; normalizeToIpv4 catches it either way.
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks octal 0177.0.0.1 (= 127.0.0.1) via normalizeToIpv4', () => {
    // The WHATWG URL parser may or may not canonicalize octal — ssrfGuard handles it explicitly.
    const testUrl = { hostname: '0177.0.0.1', protocol: 'http:' } as URL;
    expect(ssrfGuard(testUrl)).not.toBeNull();
  });

  it('blocks hex 0x7f.0.0.1 (= 127.0.0.1) via normalizeToIpv4', () => {
    const testUrl = { hostname: '0x7f.0.0.1', protocol: 'http:' } as URL;
    expect(ssrfGuard(testUrl)).not.toBeNull();
  });

  it('blocks two-part 127.1 (= 127.0.0.1) via normalizeToIpv4', () => {
    const testUrl = { hostname: '127.1', protocol: 'http:' } as URL;
    expect(ssrfGuard(testUrl)).not.toBeNull();
  });

  it('blocks single-hex 0xC0A80101 (= 192.168.1.1) via normalizeToIpv4', () => {
    const testUrl = { hostname: '0xc0a80101', protocol: 'http:' } as URL;
    expect(ssrfGuard(testUrl)).not.toBeNull();
  });
});

describe('ssrfGuard — private hostnames', () => {
  it('blocks localhost', () =>
    expect(ssrfGuard(new URL('http://localhost/'))).not.toBeNull());
  it('blocks foo.local', () =>
    expect(ssrfGuard({ hostname: 'foo.local', protocol: 'http:' } as URL)).not.toBeNull());
  it('blocks metadata.google.internal', () =>
    expect(ssrfGuard({ hostname: 'metadata.google.internal', protocol: 'http:' } as URL)).not.toBeNull());
  it('allows example.com', () =>
    expect(ssrfGuard(new URL('http://example.com/'))).toBeNull());
});

describe('ssrfGuard — IPv6 (driven through new URL() per secSys #71 regression methodology)', () => {
  // METHODOLOGY: drive inputs through new URL() first — the WHATWG URL parser canonicalizes
  // IPv4-mapped IPv6 to HEX form (::ffff:7f00:1), NOT dotted form (::ffff:127.0.0.1).
  // Tests that use idealized dotted strings pass even when the fix is broken; these don't.

  it('blocks ::1 (loopback) — via new URL', () =>
    expect(ssrfGuard(new URL('http://[::1]/'))).not.toBeNull());

  it('blocks ::ffff:127.0.0.1 as HEX (::ffff:7f00:1) — the #71 bypass class', () => {
    // new URL serializes to hex; the old dotted regex was dead code against this form
    const url = new URL('http://[::ffff:7f00:1]/');
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks ::ffff:169.254.169.254 (cloud metadata) as HEX (::ffff:a9fe:a9fe)', () => {
    // This was the concrete bypass: cloud metadata reachable via hex v4-mapped IPv6
    const url = new URL('http://[::ffff:a9fe:a9fe]/');
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks ::ffff:10.0.0.1 (RFC-1918 via v4-mapped hex)', () => {
    const url = new URL('http://[::ffff:a00:1]/');  // 10.0.0.1 = 0x0a000001 = a00:1
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks ::ffff:192.168.1.1 (RFC-1918 via v4-mapped hex)', () => {
    const url = new URL('http://[::ffff:c0a8:101]/');  // 192.168.1.1 = c0a8:0101
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks fully-expanded form [0:0:0:0:0:ffff:7f00:1] (= 127.0.0.1)', () => {
    const url = new URL('http://[0:0:0:0:0:ffff:7f00:1]/');
    expect(ssrfGuard(url)).not.toBeNull();
  });

  it('blocks fc00::1 (ULA) — via new URL', () =>
    expect(ssrfGuard(new URL('http://[fc00::1]/'))).not.toBeNull());

  it('blocks fe80::1 (link-local) — via new URL', () =>
    expect(ssrfGuard(new URL('http://[fe80::1]/'))).not.toBeNull());

  it('allows a public IPv6 address — via new URL', () =>
    expect(ssrfGuard(new URL('http://[2001:db8::1]/'))).toBeNull());
});

// ===========================================================================
// parseMetadata unit tests
// ===========================================================================

describe('parseMetadata', () => {
  const base = 'https://example.com/page';

  it('extracts og: fields', () => {
    const html = ogHtml({
      ogTitle: 'OG Title',
      ogDesc: 'OG description',
      ogImage: 'https://example.com/img.png',
      ogSite: 'Example',
      title: 'Page Title',
    });
    const r = parseMetadata(html, base);
    expect(r.title).toBe('OG Title'); // og:title wins
    expect(r.description).toBe('OG description');
    expect(r.image).toBe('https://example.com/img.png');
    expect(r.siteName).toBe('Example');
  });

  it('falls back to <title> when og:title is absent', () => {
    const html = ogHtml({ title: 'Just a Title' });
    expect(parseMetadata(html, base).title).toBe('Just a Title');
  });

  it('resolves relative og:image to absolute', () => {
    const html = ogHtml({ ogImage: '/preview.png' });
    expect(parseMetadata(html, base).image).toBe('https://example.com/preview.png');
  });

  it('discards og:image with non-http scheme (data: URLs etc.)', () => {
    const html = ogHtml({ ogImage: 'data:image/png;base64,abc' });
    expect(parseMetadata(html, base).image).toBeNull();
  });

  it('resolves favicon href to absolute', () => {
    const html = ogHtml({ favicon: '/favicon.svg' });
    expect(parseMetadata(html, base).favicon).toBe('https://example.com/favicon.svg');
  });

  it('defaults favicon to /favicon.ico when no <link rel=icon>', () => {
    const html = ogHtml({ title: 'No Favicon' });
    expect(parseMetadata(html, base).favicon).toBe('https://example.com/favicon.ico');
  });

  it('decodes HTML entities in text fields', () => {
    const html = `<html><head>
      <meta property="og:title" content="Rock &amp; Roll" />
      <meta property="og:description" content="Less &lt;than&gt;" />
    </head></html>`;
    const r = parseMetadata(html, base);
    expect(r.title).toBe('Rock & Roll');
    expect(r.description).toBe('Less <than>');
  });

  it('handles content-before-property attribute order', () => {
    const html = `<html><head>
      <meta content="Reversed Order" property="og:title" />
    </head></html>`;
    expect(parseMetadata(html, base).title).toBe('Reversed Order');
  });

  it('returns null for all fields when <head> is empty', () => {
    const r = parseMetadata('<html><head></head><body></body></html>', base);
    expect(r.title).toBeNull();
    expect(r.description).toBeNull();
    expect(r.image).toBeNull();
    expect(r.siteName).toBeNull();
    // favicon defaults even with empty head
    expect(r.favicon).toBe('https://example.com/favicon.ico');
  });
});

// ===========================================================================
// Route integration tests
// ===========================================================================

describe('GET /api/unfurl — route integration', () => {
  it('production + no bearer: 401 before any fetch (F13 fail-closed)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await getUnfurl(makeEnv({ ENVIRONMENT: 'production' }), 'https://example.com/');
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing url param: 400 invalid_request', async () => {
    const res = await app.request('/api/unfurl', {}, makeEnv());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('malformed URL: 400 invalid_request', async () => {
    const res = await getUnfurl(makeEnv(), 'not-a-url');
    expect(res.status).toBe(400);
  });

  it('SSRF: file:// scheme → 400 invalid_url, no fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await getUnfurl(makeEnv(), 'file:///etc/passwd');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('invalid_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSRF: 127.0.0.1 → 400 invalid_url, no fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await getUnfurl(makeEnv(), 'http://127.0.0.1/secret');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSRF: 169.254.169.254 (cloud metadata) → 400, no fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await getUnfurl(makeEnv(), 'http://169.254.169.254/latest/meta-data/');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSRF: redirect to private IP → 400 invalid_url (re-validate on each hop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response('', {
          status: 301,
          headers: { location: 'http://192.168.0.1/internal' },
        }),
      ),
    );

    const res = await getUnfurl(makeEnv(), 'https://example.com/redir');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('invalid_url');
  });

  it('non-HTML response (content-type: application/pdf) → 502 fetch_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      ),
    );

    const res = await getUnfurl(makeEnv(), 'https://example.com/doc.pdf');
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('fetch_failed');
  });

  it('upstream 404 → 502 fetch_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })),
    );

    const res = await getUnfurl(makeEnv(), 'https://example.com/missing');
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('fetch_failed');
  });

  it('happy path: returns parsed og: metadata for a valid public URL', async () => {
    const html = ogHtml({
      ogTitle: 'Test Page',
      ogDesc: 'A test description',
      ogImage: 'https://example.com/img.png',
      ogSite: 'Example Site',
      favicon: '/favicon.ico',
      title: 'Fallback',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );

    const res = await getUnfurl(makeEnv(), 'https://example.com/page');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      url: string;
      title: string;
      description: string;
      image: string;
      favicon: string;
      siteName: string;
    };
    expect(body.url).toBe('https://example.com/page');
    expect(body.title).toBe('Test Page'); // og:title wins over <title>
    expect(body.description).toBe('A test description');
    expect(body.image).toBe('https://example.com/img.png');
    expect(body.favicon).toBe('https://example.com/favicon.ico');
    expect(body.siteName).toBe('Example Site');
  });

  it('KV cache: stores result on first call and serves it without re-fetching on second', async () => {
    const html = ogHtml({ title: 'Cached Page' });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const kv = stubKv();
    const env = makeEnv({ UNFURL_CACHE: kv as unknown as KVNamespace });

    const res1 = await getUnfurl(env, 'https://example.com/cached');
    expect(res1.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);

    // Second call — KV store now has the entry; should hit cache without re-fetching.
    const res2 = await getUnfurl(env, 'https://example.com/cached');
    expect(res2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still exactly 1
    expect((await res2.json() as { title: string }).title).toBe('Cached Page');
  });

  it(
    'production + valid bearer: authenticated session unfurls successfully',
    async () => {
      const raw = freshDb();
      const html = ogHtml({ title: 'Auth Test Page' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        ),
      );

      const env = makeEnv({ ENVIRONMENT: 'production' }, raw);

      const signup = await app.request(
        '/api/auth/signup',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'unfurluser', password: 'correct horse battery staple' }),
        },
        env,
      );
      expect(signup.status).toBe(201);
      const { token } = (await signup.json()) as { token: string };

      const res = await app.request(
        `/api/unfurl?url=${encodeURIComponent('https://example.com/')}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(res.status).toBe(200);
      expect((await res.json() as { title: string }).title).toBe('Auth Test Page');
    },
    T,
  );
});
