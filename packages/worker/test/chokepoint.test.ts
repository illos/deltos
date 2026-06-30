import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { NoteRefSchema } from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import { guard, type GuardDeps, type AppContext } from '../src/http.js';
import type { Env } from '../src/env.js';

/**
 * Chokepoint tests. They lock the guard's ORDER — validate → tripwire → authorize → handle —
 * and prove no path reaches a handler when an earlier gate fails. This is what protects the
 * ordering when Phase 1 swaps the allow-all stub for a real `can()`.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// `development` is an explicit allowlist member (F13), so the unverified stub passes the
// fail-closed tripwire and these ordering tests exercise validate→authorize→handle. An UNSET
// ENVIRONMENT now DENIES (fail-closed) — the F13 allowlist matrix is covered in auth.acceptance.test.ts.
const devEnv = { DB: {}, ENVIRONMENT: 'development' } as unknown as Env;
const prodEnv = { DB: {}, ENVIRONMENT: 'production' } as unknown as Env;

/** A one-route app guarding `note.get`, with injectable auth deps and a spy handler. */
function appWith(deps: GuardDeps, handle: ReturnType<typeof vi.fn>) {
  const app = new Hono<{ Bindings: Env }>();
  app.get(
    '/t/:id',
    guard(
      {
        op: 'read',
        schema: NoteRefSchema,
        input: (c) => ({ id: c.req.param('id') }),
        resource: (req): Resource => ({ kind: 'note', id: req.id }),
        handle,
      },
      deps,
    ),
  );
  return app;
}

describe('guard chokepoint ordering', () => {
  it('denies (403) and does NOT invoke the handler when can() is false', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => false }, handle);
    const res = await app.request(`/t/${uuid(1)}`, {}, devEnv);
    expect(res.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects bad input (400) and does NOT invoke the handler', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => true }, handle);
    const res = await app.request(`/t/not-a-uuid`, {}, devEnv);
    expect(res.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('validates BEFORE authorizing — invalid input never reaches can()', async () => {
    const check = vi.fn(async () => false);
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: check }, handle);
    const res = await app.request(`/t/not-a-uuid`, {}, devEnv);
    expect(res.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('TRIPWIRE: refuses (503) an unverified principal in production, handler never runs', async () => {
    // No resolvePrincipal override → uses the real stub, which yields an `unverified` principal.
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => true }, handle);
    const res = await app.request(`/t/${uuid(1)}`, {}, prodEnv);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('allows a valid, authorized request through to the handler', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => true }, handle);
    const res = await app.request(`/t/${uuid(1)}`, {}, devEnv);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });
});

/**
 * Tier-1 coarse per-principal request-rate ceiling (ROAD-0005 P4). The gate sits AFTER the F13 tripwire
 * and BEFORE `can()` + the handler, keyed on `principal.id`. It fails OPEN — an unbound or throwing
 * limiter must never block legitimate traffic.
 */
describe('guard Tier-1 request-rate ceiling', () => {
  // A devEnv (F13 allowlist member, so the unverified stub passes the tripwire) carrying an injected
  // native rate-limit binding stub.
  const rateEnv = (limiter: unknown) =>
    ({ DB: {}, ENVIRONMENT: 'development', API_RATE_LIMITER: limiter }) as unknown as Env;

  it('returns 429 rate_limited and reaches NEITHER can() nor the handler when over the ceiling', async () => {
    const check = vi.fn(async () => true);
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: check }, handle);
    const env = rateEnv({ limit: async () => ({ success: false }) });
    const res = await app.request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(check).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('proceeds normally when the limiter reports under the ceiling', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => true }, handle);
    const env = rateEnv({ limit: async () => ({ success: true }) });
    const res = await app.request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('FAILS OPEN — an unbound limiter binding proceeds normally', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const app = appWith({ can: async () => true }, handle);
    // devEnv has no API_RATE_LIMITER → principalRateAllow returns true (allow).
    const res = await app.request(`/t/${uuid(1)}`, {}, devEnv);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });
});
