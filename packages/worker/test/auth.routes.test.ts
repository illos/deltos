import { describe, it, expect } from 'vitest';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

/**
 * Auth route SKELETON tests. They pin the routing SURFACE: every /api/auth/* endpoint is mounted
 * and reaches its handler (returns 501 contract-only, NOT a 404 from the notFound fallback). This
 * is what proves the wiring is real before authCrypto/authStore land — when handlers flip live,
 * these 501 expectations become the per-route behavioural assertions (200/401/etc.).
 */

const env = { DB: {}, ENVIRONMENT: 'development' } as unknown as Env;

const notImplemented = async (res: Response) => {
  expect(res.status).toBe(501);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('not_implemented');
};

describe('auth routes are mounted (skeleton)', () => {
  it('POST /api/auth/challenge is wired (501, not 404)', async () => {
    const res = await app.request('/api/auth/challenge', { method: 'POST' }, env);
    await notImplemented(res);
  });

  it('POST /api/auth/register is wired (501, not 404)', async () => {
    const res = await app.request('/api/auth/register', { method: 'POST' }, env);
    await notImplemented(res);
  });

  it('POST /api/auth/session is wired (501, not 404)', async () => {
    const res = await app.request('/api/auth/session', { method: 'POST' }, env);
    await notImplemented(res);
  });

  it('GET /api/auth/devices is wired (501, not 404)', async () => {
    const res = await app.request('/api/auth/devices', {}, env);
    await notImplemented(res);
  });

  it('POST /api/auth/devices/:keyId/revoke is wired (501, not 404)', async () => {
    const res = await app.request('/api/auth/devices/dev-handle/revoke', { method: 'POST' }, env);
    await notImplemented(res);
  });

  it('an unknown /api/auth path still 404s (fallback intact)', async () => {
    const res = await app.request('/api/auth/nope', { method: 'POST' }, env);
    expect(res.status).toBe(404);
  });
});
