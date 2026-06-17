import app from '../../src/index.js';
import type { Env } from '../../src/env.js';

/**
 * Mint a real access token via the password-auth `/signup` endpoint — the post-pivot replacement for the
 * retired signed-challenge register+session mint. Returns the bearer + the server-assigned accountId so
 * cross-account tests can stand up two distinct accounts by signing up two distinct usernames.
 *
 * The caller's `env` MUST carry `AUTH_PEPPER` (signup hashes the password). The downstream data layer is
 * credential-agnostic (keys on accountId from the grant), so notes/sync/isolation assertions are
 * unchanged — only HOW the token is minted moved from a device key to a username+password.
 */
export async function signupToken(
  env: Env,
  username: string,
  password = 'correct-horse-battery-staple',
): Promise<{ token: string; accountId: string }> {
  const res = await app.request(
    '/api/auth/signup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    },
    env,
  );
  if (res.status !== 201) throw new Error(`signup(${username}) failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; accountId: string };
  return { token: body.token, accountId: body.accountId };
}
