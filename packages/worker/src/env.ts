/**
 * Worker bindings. D1 is the only binding in Phase 0 — Durable Objects (collab / E2EE relay)
 * and R2 (blob store) are reserved by the architecture and intentionally absent.
 */
export interface Env {
  DB: D1Database;
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
   */
  AUTH_AUDIENCE?: string;
}
