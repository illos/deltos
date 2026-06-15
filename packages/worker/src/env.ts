/**
 * Worker bindings. D1 is the only binding in Phase 0 — Durable Objects (collab / E2EE relay)
 * and R2 (blob store) are reserved by the architecture and intentionally absent.
 */
export interface Env {
  DB: D1Database;
  /**
   * Deployment environment. When set to 'production', the chokepoint REFUSES any unverified
   * principal — the mechanical tripwire that stops the Phase-0 allow-all/unverified auth stub
   * from ever serving real traffic. Unset/anything-else = development (stub allowed).
   */
  ENVIRONMENT?: string;
}
