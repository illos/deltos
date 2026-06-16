import type { z } from 'zod';
import type { CanCheck, Op, Resource, RequestPrincipal } from '@deltos/shared';
import { resolvePrincipal, can } from './auth.js';
import type { AppContext } from './context.js';

export type { AppContext };

/** One error envelope for the whole API, so every client decodes failures the same way. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(
  c: AppContext,
  status: 400 | 403 | 404 | 409 | 500 | 501 | 503,
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
  handle: (req: TReq, c: AppContext) => Response | Promise<Response>;
}

/**
 * Authorization dependencies, injectable so the chokepoint ordering can be unit-tested against
 * a stub `can`. Production code passes nothing and gets the real {@link can} / {@link resolvePrincipal}.
 */
export interface GuardDeps {
  can?: CanCheck;
  resolvePrincipal?: (c: AppContext) => RequestPrincipal;
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
    const principal = resolve(c);
    // Mechanical tripwire: the Phase-0 stub yields an `unverified` principal. In production that
    // must NEVER be honored — refuse before authorization or any handler runs, so the allow-all
    // stub cannot silently serve real traffic once Phase-1 handlers replace these stubs.
    if (principal.verification.method === 'unverified' && c.env.ENVIRONMENT === 'production') {
      return apiError(
        c,
        503,
        'auth_not_configured',
        'refusing an unverified principal in production',
      );
    }
    const resource = cfg.resource(parsed.data);
    const allowed = await check(principal, cfg.op, resource);
    if (!allowed) {
      return apiError(c, 403, 'forbidden', `principal not permitted to ${cfg.op} this resource`);
    }
    return cfg.handle(parsed.data, c);
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
