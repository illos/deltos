/**
 * Worker bindings. D1 is the only binding in Phase 0 — Durable Objects (collab / E2EE relay)
 * and R2 (blob store) are reserved by the architecture and intentionally absent.
 */
export interface Env {
  DB: D1Database;
}
