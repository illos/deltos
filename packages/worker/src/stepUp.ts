import { z } from 'zod';
import { verifyPassword } from './passwordCrypto.js';
import { verifyTotp, decryptSecret } from './totp.js';
import { ARGON2_PARAMS } from './authPolicy.js';
import { apiError } from './http.js';
import type { AppContext } from './context.js';
import type { AuthStore } from './db/authStore.js';

/**
 * Step-up ("sudo-mode") re-authentication — H1 of the API-access security program (ROAD-0005 P0;
 * docs/design/api-access-security-model.md §2). A live session bearer authorizes day-to-day work, but a
 * FEW actions are sensitive enough that we re-prove the *human* at the moment of the action, not just the
 * session: minting a long-lived, non-expiring, read-all agent token is the first (an agent token has NO
 * TTL — issuance is the only checkpoint in its whole life, so the bar is full re-auth).
 *
 * This is the reusable seam P2 (credential-lifecycle) generalizes — OAuth consent and any future
 * destructive op call the same `verifyStepUp`. It mirrors the /login factor checks exactly: password
 * ALWAYS, plus a current TOTP code when 2FA is enabled. Fail-closed throughout.
 */

/** The re-auth factors a step-up-gated request carries (rides in the action's own request body). */
export const StepUpFactorsSchema = z.object({
  password: z.string().min(1).optional(),
  totp: z.string().optional(),
});
export type StepUpFactors = z.infer<typeof StepUpFactorsSchema>;

/**
 * Re-authenticate an already-authenticated owner before a sensitive action. Returns `null` on success;
 * an `apiError` Response on ANY failure (the caller returns it unchanged). The account is the
 * server-derived owner accountId — NEVER taken from the body.
 *
 * Note: this runs an Argon2id verify (~290ms CPU) — acceptable for rare sensitive actions, and the
 * caller's per-account rate-limit (ROAD-0005 P0 item C) bounds password-guessing through this path.
 */
export async function verifyStepUp(
  c: AppContext,
  s: AuthStore,
  accountId: string,
  factors: StepUpFactors,
  nowMs: number,
): Promise<Response | null> {
  const pepper = c.env.AUTH_PEPPER;
  if (!pepper) return apiError(c, 503, 'auth_not_configured', 'AUTH_PEPPER is not configured');

  const credential = await s.getCredentialByAccount(accountId);
  // An authenticated principal with no password credential cannot step up — fail closed.
  if (!credential) return apiError(c, 403, 'step_up_required', 'step-up re-authentication is required');

  if (!factors.password) {
    return apiError(c, 401, 'password_required', 'your password is required to authorize this action');
  }
  const verdict = verifyPassword(factors.password, credential.passwordPhc, pepper, ARGON2_PARAMS);
  if (!verdict.ok) {
    return apiError(c, 401, 'password_invalid', 'that password is not correct');
  }

  // Second factor — required iff the account has 2FA enabled (mirrors /login).
  if (credential.totpEnabled) {
    const encKey = c.env.TOTP_ENC_KEY;
    if (!encKey) return apiError(c, 503, 'auth_not_configured', 'TOTP_ENC_KEY is not configured');
    if (!factors.totp || !credential.totpSecretEnc) {
      return apiError(c, 401, 'totp_required', 'a two-factor code is required to authorize this action');
    }
    const secret = await decryptSecret(credential.totpSecretEnc, encKey);
    const totp = verifyTotp(secret, factors.totp, nowMs, credential.totpLastStep);
    if (!totp.ok) {
      return apiError(c, 401, 'totp_invalid', 'that two-factor code is not valid');
    }
    await s.advanceTotpStep(accountId, totp.step, new Date(nowMs).toISOString()); // replay guard moves forward
  }

  return null;
}
