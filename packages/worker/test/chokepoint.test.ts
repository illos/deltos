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
const devEnv = { DB: {} } as unknown as Env;
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
