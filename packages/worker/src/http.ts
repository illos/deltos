import type { z } from 'zod';
import type { CanCheck, Op, Resource, RequestPrincipal } from '@deltos/shared';
import { resolvePrincipal, can } from './auth.js';
import type { AppContext } from './context.js';

export type { AppContext };

/**
 * The closed, exact-match allowlist of environments in which the dev-only `unverified` principal is
 * tolerated (F13). Membership is the ONLY way the stub is honored — anything else (production, an
 * unset var, a typo like `prod`, a near-match like `development-2`) DENIES. The tripwire is therefore
 * fail-CLOSED: a misconfigured or unset deploy REFUSES rather than serving the allow-all stub on real
 * data. Inverting the P0 `=== 'production'` check (which fail-OPENed on any non-prod string) closes
 * the bypass where an unset/typo'd ENVIRONMENT silently honored an unverified principal.
 */
export const NON_PROD_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test', 'local']);

/** One error envelope for the whole API, so every client decodes failures the same way. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(
  c: AppContext,
  status: 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return c.json(body, status);
}

/**
 * The single authorization chokepoint, expressed as a route factory. Every mutating/reading
 * operation is built through `guard`, so the order is identical and unskippable everywhere:
 *
 *   1. assemble the raw input for this route (body / params / query)
 *   2. validate it against the operation's schema — reject at the boundary, never trust
 *   3. resolve the live principal (with its verification proof)
 *   4. derive the resource and run the one `can(principal, op, resource)` check
 *   5. only then hand the validated request to the typed handler
 *
 * There is no path to a handler that bypasses validation or `can()`.
 */
export interface GuardConfig<TReq> {
  op: Op;
  schema: z.ZodType<TReq, z.ZodTypeDef, unknown>;
  input: (c: AppContext) => unknown | Promise<unknown>;
  resource: (req: TReq) => Resource;
  /**
   * The typed handler. Receives the resolved, authorized `principal` as a 3rd arg (the single seam
   * both notes + sync use to get the caller's account: `callerAccountId(principal)` — `principal.id`
   * is the `accountId`, NOT a fingerprint, after the re-point). The same principal is also on the
   * context (`requireAccountId(c)`) for code paths that only hold `c`.
   */
  handle: (req: TReq, c: AppContext, principal: RequestPrincipal) => Response | Promise<Response>;
}

/**
 * Authorization dependencies, injectable so the chokepoint ordering can be unit-tested against
 * a stub `can`. Production code passes nothing and gets the real {@link can} / {@link resolvePrincipal}.
 */
export interface GuardDeps {
  can?: CanCheck;
  resolvePrincipal?: (c: AppContext) => RequestPrincipal | Promise<RequestPrincipal>;
}

export function guard<TReq>(cfg: GuardConfig<TReq>, deps: GuardDeps = {}) {
  const resolve = deps.resolvePrincipal ?? resolvePrincipal;
  const check = deps.can ?? can;
  return async (c: AppContext): Promise<Response> => {
    const raw = await cfg.input(c);
    const parsed = cfg.schema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        c,
        400,
        'invalid_request',
        'request failed validation',
        parsed.error.format(),
      );
    }
    const principal = await resolve(c);
    // Mechanical tripwire (F13, fail-CLOSED): the dev-only `unverified` principal is honored ONLY in
    // an explicitly-named non-prod environment. Anything else — production, an UNSET var, a typo, a
    // near-match — refuses before authorization or any handler runs, so the allow-all stub can never
    // silently serve real traffic (including on a misconfigured deploy).
    if (
      principal.verification.method === 'unverified' &&
      !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')
    ) {
      return apiError(
        c,
        503,
        'auth_not_configured',
        'refusing an unverified principal outside an explicit non-prod environment',
      );
    }
    const resource = cfg.resource(parsed.data);
    const allowed = await check(principal, cfg.op, resource);
    if (!allowed) {
      return apiError(c, 403, 'forbidden', `principal not permitted to ${cfg.op} this resource`);
    }
    // Surface the resolved principal to the handler via the context — the SINGLE shared way handlers
    // get the caller's account (read `requireAccountId(c)` in db/accountScope.ts). Set only after the
    // tripwire + can() pass, so a handler can never read a principal that was not authorized. Both the
    // notes routes (scopeSys) and sync routes (devSys2) MUST scope through this one path — no handler
    // re-resolves the principal or reads `principal.id` directly (that would be a fail-open seam).
    c.set('principal', principal);
    return cfg.handle(parsed.data, c, principal);
  };
}

/** Phase-0 stub handler: the operation's contract is wired and authorized, impl lands in Phase 1. */
export function notImplemented(c: AppContext, operation: string): Response {
  return apiError(
    c,
    501,
    'not_implemented',
    `operation '${operation}' is contract-only in Phase 0`,
  );
}
