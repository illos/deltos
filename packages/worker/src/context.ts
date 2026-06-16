import type { Context } from 'hono';
import type { RequestPrincipal } from '@deltos/shared';
import type { Env } from './env.js';

/**
 * Context variables set by the chokepoint and read downstream.
 *
 * `principal` is set by `guard()` once it has resolved + authorized the live principal, so handlers
 * (and the account-scope helper) read the SAME resolved principal instead of re-resolving. After the
 * zero-delta re-point (migration 0003), `principal.id` MEANS `accountId` — see `db/accountScope.ts`.
 */
export interface AppVariables {
  /** Optional: only set on guarded routes (the unauthenticated auth bootstrap never has a principal). */
  principal?: RequestPrincipal;
}

/** The full Hono env for this worker — bindings + context variables. Routers use `new Hono<AppEnv>()`. */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

/** The Hono context shape for this worker, shared so auth and http agree on the same type. */
export type AppContext = Context<AppEnv>;
