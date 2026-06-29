/**
 * Diagnostic snapshot export (dev/dogfood troubleshooting tool).
 *
 * Builds a `deltos-snapshot-<ISO>.zip` of the client's LOCAL state + environment so Jim can hand it
 * over when something is wedged that we can't see from the server — the immediate motivator being a
 * `push 400` caused by a malformed op stuck in the local sync queue, which lives only in the browser's
 * IndexedDB. The zip carries:
 *   - `indexeddb.json`   — every Dexie table dumped (see {@link collectSnapshotFiles}).
 *   - `manifest.json`    — app/build/env/sync/account context.
 *   - `localstorage.json`— all localStorage entries, credential-redacted.
 *
 * 🔒 SECURITY (HARD): the zip must NEVER contain credentials. The access/bearer token is read from the
 * auth store and DROPPED (never serialized); localStorage is redacted by key/value pattern; the
 * `blobCache` bytes are omitted (size + perf, not security). The httpOnly refresh cookie is unreachable
 * from JS, so it's excluded by construction — we never read document.cookie. Note CONTENT is deliberately
 * KEPT (the stuck op is the whole point, and it's the user's own data).
 *
 * Perf (FN-8 lazy-split): this module AND `fflate` are dynamically `import()`ed on the Settings button
 * click — they must never enter the entry/first-load chunk. {@link collectSnapshotFiles} is a pure
 * function over injected inputs so the security + shape assertions can unit-test it with no DOM/Dexie.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

/** A Dexie-table-shaped source — name + a full read. (db.tables members satisfy this.) */
export interface SnapshotTable {
  name: string;
  toArray(): Promise<unknown[]>;
}

/** A localStorage-shaped source (the real `Storage`, or a mock in tests). */
export interface SnapshotStorage {
  length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

/**
 * The full auth-store slice handed to the collector. We accept the WHOLE shape (incl. `bearerToken`)
 * ON PURPOSE: the collector itself selects only the non-credential identifiers, so the security test
 * can pass a real-looking token here and assert it never reaches the output. Nothing but
 * accountId/username/keyId-presence is read.
 */
export interface SnapshotAuth {
  bearerToken?: string | null;
  accountId: string | null;
  username: string | null;
  /** Passkey-era identifier; absent under the password pivot. We record only its PRESENCE, never the value. */
  keyId?: string | null;
}

export interface SnapshotSync {
  queueDepth: number;
  lastSeq: number;
  lastError: string | null;
  status: string;
}

export interface SnapshotServiceWorker {
  registered: boolean;
  hasController: boolean;
  controllerScriptURL: string | null;
  waiting: boolean;
}

export interface SnapshotEnv {
  servedBundle: string | null;
  userAgent: string;
  platform: string;
  language: string;
  online: boolean;
  viewport: { width: number; height: number };
  serviceWorker: SnapshotServiceWorker;
}

export interface SnapshotInputs {
  exportedAt: string;
  appVersion: string;
  buildTime: string;
  dexieSchemaVersion: number;
  tables: SnapshotTable[];
  storage: SnapshotStorage;
  auth: SnapshotAuth;
  sync: SnapshotSync;
  env: SnapshotEnv;
}

/**
 * Credential pattern. A localStorage key OR value matching this is redacted to `"[redacted]"`. Tuned to
 * the spec: token/secret/password/passphrase/recovery/private/bearer/jwt anywhere, or a name ending in
 * `key` (the `$` anchors only that final alternative). Identifiers/settings (accountId, username, theme,
 * sync cursors, feature flags) don't match → kept. Bias: when unsure, redact.
 */
const CREDENTIAL_RE = /token|secret|password|passphrase|recovery|private|bearer|jwt|key$/i;

/** The `blobCache` bytes-bearing table — dumped METADATA ONLY (bytes omitted: huge + unneeded). */
const BLOB_CACHE_TABLE = 'blobCache';

/**
 * Replace binary payloads (ArrayBuffer / typed-array views / Blob) with a compact placeholder so the
 * JSON neither chokes nor bloats. Used as the JSON.stringify replacer for the IndexedDB dump — any blob
 * anywhere in any row (not just blobCache) collapses to `{__omitted, byteLength}`.
 */
function omitBinary(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { __omitted: 'ArrayBuffer', byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) {
    return { __omitted: value.constructor?.name ?? 'TypedArray', byteLength: (value as ArrayBufferView).byteLength };
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return { __omitted: 'Blob', byteLength: value.size };
  }
  return value;
}

/** Project a blobCache row down to byte-free metadata (drop the `bytes` ArrayBuffer entirely). */
function blobCacheMeta(row: unknown): unknown {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    accountId: r.accountId,
    resourceKey: r.resourceKey,
    size: r.size,
    mime: r.mime,
    lastAccess: r.lastAccess,
  };
}

/** Redact a localStorage map: any key/value matching {@link CREDENTIAL_RE} → `"[redacted]"`. */
function redactStorage(storage: SnapshotStorage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k == null) continue;
    const v = storage.getItem(k) ?? '';
    out[k] = CREDENTIAL_RE.test(k) || CREDENTIAL_RE.test(v) ? '[redacted]' : v;
  }
  return out;
}

/**
 * PURE collector — turn injected inputs into the three snapshot files (filename → JSON string). No
 * DOM, no Dexie, no globals: everything it needs is in `inputs`, which is what makes the security +
 * shape assertions unit-testable. The bearer token in `inputs.auth` is read for NOTHING — proof that
 * it cannot leak is that this function only ever touches accountId / username / keyId-presence.
 */
export async function collectSnapshotFiles(inputs: SnapshotInputs): Promise<Record<string, string>> {
  // 1. indexeddb.json — every table; blobCache → metadata only; binary anywhere → placeholder.
  const tables: Record<string, unknown[]> = {};
  for (const table of inputs.tables) {
    const rows = await table.toArray();
    tables[table.name] = table.name === BLOB_CACHE_TABLE ? rows.map(blobCacheMeta) : rows;
  }
  const indexeddb = JSON.stringify(
    { dexieSchemaVersion: inputs.dexieSchemaVersion, tables },
    omitBinary,
    2,
  );

  // 2. manifest.json — app/build/env/sync/account context. Token DROPPED: only identifiers + presence.
  const manifest = JSON.stringify(
    {
      exportedAt: inputs.exportedAt,
      appVersion: inputs.appVersion,
      buildTime: inputs.buildTime,
      servedBundle: inputs.env.servedBundle,
      dexieSchemaVersion: inputs.dexieSchemaVersion,
      userAgent: inputs.env.userAgent,
      platform: inputs.env.platform,
      language: inputs.env.language,
      online: inputs.env.online,
      viewport: inputs.env.viewport,
      serviceWorker: inputs.env.serviceWorker,
      sync: {
        queueDepth: inputs.sync.queueDepth,
        lastSeq: inputs.sync.lastSeq,
        lastError: inputs.sync.lastError,
        status: inputs.sync.status,
      },
      account: {
        accountId: inputs.auth.accountId,
        username: inputs.auth.username,
        keyIdPresent: inputs.auth.keyId != null,
      },
    },
    null,
    2,
  );

  // 3. localstorage.json — all entries, credential-redacted.
  const localstorage = JSON.stringify(redactStorage(inputs.storage), null, 2);

  return {
    'indexeddb.json': indexeddb,
    'manifest.json': manifest,
    'localstorage.json': localstorage,
  };
}

/** Zip a {filename → text} map with fflate (synchronous, tiny). */
export function zipSnapshotFiles(files: Record<string, string>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) zippable[name] = strToU8(content);
  return zipSync(zippable);
}

// ── Real-environment wiring (browser-only; not exercised by the pure unit test) ──────────────────────

/** Find the served entry bundle (`/assets/index-*.js`) from the document's script tags. */
function findServedBundle(): string | null {
  if (typeof document === 'undefined') return null;
  for (const s of Array.from(document.querySelectorAll('script[src]'))) {
    const src = (s as HTMLScriptElement).src;
    if (/\/assets\/index-[^/]*\.js/.test(src)) return src;
  }
  return null;
}

async function gatherServiceWorker(): Promise<SnapshotServiceWorker> {
  const empty: SnapshotServiceWorker = {
    registered: false,
    hasController: false,
    controllerScriptURL: null,
    waiting: false,
  };
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return empty;
  const sw = navigator.serviceWorker;
  const reg = await sw.getRegistration().catch(() => null);
  return {
    registered: !!reg,
    hasController: !!sw.controller,
    controllerScriptURL: sw.controller?.scriptURL ?? null,
    waiting: !!reg?.waiting,
  };
}

/**
 * Gather the live inputs from the real browser + app modules, then run the pure collector. Dynamically
 * imports the app stores/engine so this module stays dependency-light for the lazy chunk. NEVER reads
 * document.cookie (the refresh cookie is httpOnly anyway).
 */
async function gatherInputs(exportedAt: string): Promise<SnapshotInputs> {
  const [{ db }, { useAuthStore }, sync] = await Promise.all([
    import('../db/schema.js'),
    import('../auth/store.js'),
    import('./syncEngine.js'),
  ]);

  const auth = useAuthStore.getState();
  const accountId = auth.accountId;
  const queueDepth = await db.syncQueue.count();
  const lastSeq = accountId ? sync.getSyncCursor(accountId) : 0;

  return {
    exportedAt,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    buildTime: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
    dexieSchemaVersion: db.verno,
    tables: db.tables,
    storage: localStorage,
    // Pass the whole auth slice; collectSnapshotFiles selects only identifiers (the token is dropped).
    auth: auth as SnapshotAuth,
    sync: {
      queueDepth,
      lastSeq,
      lastError: sync.getLastSyncError(),
      status: sync.getSyncState(),
    },
    env: {
      servedBundle: findServedBundle(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      platform: typeof navigator !== 'undefined' ? navigator.platform : '',
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      online: typeof navigator !== 'undefined' ? navigator.onLine : false,
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 0,
        height: typeof window !== 'undefined' ? window.innerHeight : 0,
      },
      serviceWorker: await gatherServiceWorker(),
    },
  };
}

/** Trigger a browser download of `bytes` as `filename`. */
function triggerDownload(bytes: Uint8Array, filename: string): void {
  // fflate returns a Uint8Array<ArrayBufferLike>; BlobPart wants ArrayBufferView<ArrayBuffer>. The bytes
  // are a plain (non-shared) ArrayBuffer at runtime — cast through BlobPart to satisfy the lib DOM type.
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had a tick to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build the snapshot from the live app state and trigger a download. Called from the Settings button's
 * click handler (which dynamically imports THIS module so neither it nor fflate is in the entry chunk).
 */
export async function exportDiagnosticSnapshot(): Promise<void> {
  const exportedAt = new Date().toISOString();
  const inputs = await gatherInputs(exportedAt);
  const files = await collectSnapshotFiles(inputs);
  const bytes = zipSnapshotFiles(files);
  // Colons are invalid in filenames on some platforms — make the ISO timestamp filename-safe.
  const safeStamp = exportedAt.replace(/:/g, '-');
  triggerDownload(bytes, `deltos-snapshot-${safeStamp}.zip`);
}
