/**
 * Worker bindings. D1 + Workers AI (voice-to-text, §6). Durable Objects (collab / E2EE relay) and R2
 * (blob store) remain reserved by the architecture and intentionally absent.
 */
export interface Env {
  DB: D1Database;
  /**
   * Workers AI binding (custom-keyboard spec §6 — voice-to-text). Powers POST /api/transcribe (Whisper
   * `@cf/openai/whisper-large-v3-turbo`); the same binding is reused by the later advanced-LLM spellcheck
   * add-on. Optional in the type so unit tests can inject a stub / omit it; the transcribe route
   * fail-closes (503) when it is unbound. Workers AI has NO local inference — exercise it via a deploy
   * smoke or `wrangler dev --remote`, never plain `wrangler dev`.
   */
  AI?: Ai;
  /**
   * Deployment environment (F13 fail-CLOSED tripwire). The dev-only `unverified` principal is honored
   * ONLY when this is an exact member of the non-prod allowlist {development, test, local}; production,
   * an UNSET var, or anything else REFUSES (see `NON_PROD_ENVIRONMENTS` in http.ts). A misconfigured
   * deploy denies rather than serving the allow-all stub.
   */
  ENVIRONMENT?: string;
  /**
   * The auth audience — the deployment HOSTNAME (= WebAuthn RP ID = client `location.hostname`), bound
   * into every signed auth payload (PROP-4 / F8). A configured per-deployment constant; the server uses
   * THIS, never the request Host header, when reconstructing the canonical TLV to verify a signature, so
   * a signature minted for one deployment cannot be replayed against another. One value, never a set.
   *
   * In the password pivot it is ALSO the canonical Origin host for the CSRF belt (the refresh/logout
   * cookie path checks `Origin` against this) — same one-value-per-deployment discipline.
   */
  AUTH_AUDIENCE?: string;
  /**
   * Worker-secret PEPPER for Argon2id (auth pivot, AP-6). HMAC'd into the password/recovery pre-image
   * BEFORE the hash, so a D1-only leak (PHC strings) is NOT offline-crackable — the attacker lacks this.
   * A `wrangler secret`, NEVER in `vars`. The password endpoints fail-CLOSED (503) if it is unset.
   */
  AUTH_PEPPER?: string;
  /**
   * Worker-secret AES key for TOTP-secret-at-rest encryption (AP-14). Any-length string; a 32-byte key
   * is derived via SHA-256. A `wrangler secret`. The TOTP endpoints fail-CLOSED (503) if it is unset.
   */
  TOTP_ENC_KEY?: string;
  /**
   * Optional Cloudflare Turnstile secret for the anti-abuse gate on the unauthenticated
   * register/login/reset paths (available-not-mandatory in v1). When UNSET, Turnstile is skipped (the
   * per-account exponential backoff remains the primary gate); when set, a missing/invalid token is
   * rejected by the gate BEFORE any Argon2id work (gate-before-hash).
   */
  TURNSTILE_SECRET?: string;
  /**
   * KV namespace for the unfurl result cache (GET /api/unfurl). Results are stored keyed by
   * normalized URL with a 1-hour TTL so repeated renders of the same link don't re-fetch.
   * Optional: when unbound the route still works, just without caching.
   *
   * To wire: run `wrangler kv namespace create unfurl-cache`, then add the returned id to
   * wrangler.jsonc under `kv_namespaces` with `binding: "UNFURL_CACHE"`.
   */
  UNFURL_CACHE?: KVNamespace;
  /**
   * R2 bucket for the `blob` host capability (plugin-support §7, A4 #126) — content-addressed file/photo
   * storage behind the authenticated Worker (PRIVATE bucket; access only via routes/blob.ts, keyed on the
   * server-derived accountId). Optional in the type so unit tests inject a stub / omit it; the blob route
   * fail-closes (503) when unbound. Provision: `wrangler r2 bucket create deltos-blobs`; the binding in
   * wrangler.jsonc (declared) resolves to it at deploy.
   */
  BLOBS?: R2Bucket;
  /**
   * Cloudflare Workers Images binding (file-notes spec §4 — the `compute` host capability). Transforms
   * PRIVATE R2 image bytes IN-WORKER (no public URL / zone config / dashboard image-resizing): on upload
   * the blob route pre-bakes two WebP derivatives ({hash}.thumb.webp 256² cover, {hash}.view.webp ≤2048px
   * scale-down) and on download transcodes to JPEG. Optional in the type so unit tests inject a stub / omit
   * it; every derive is NON-FATAL (a failed/absent bake never fails the upload — the original blob already
   * stored). Like `AI`, the binding has NO local implementation — `wrangler dev --remote` (or a deploy) is
   * required to exercise it; plain `wrangler dev` cannot. Declared in wrangler.jsonc as `images`.
   */
  IMAGES?: ImagesBinding;
}
