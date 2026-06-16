import { z } from 'zod';
import { base64urlDecodeStrict } from './encoding.js';
import { AUTH_PURPOSES } from './canonical.js';
import { OpSchema, ResourceSchema, ScopeSchema } from '../api/grant.js';

/**
 * The WIRE auth request bodies — the raw proof a caller presents, validated at the endpoint BEFORE
 * any crypto runs. The signature material lives ONLY here (and in the `canonical.ts` payload it signs
 * over); it is NEVER copied onto `PrincipalVerification`, which carries only the verified facts the
 * server produces post-verify. These schemas are `.strict()` (an unknown key rejects at the boundary,
 * fail-closed) and enforce R3-4: every binary field is strict, canonical, exact-length base64url, so a
 * malformed or oversized blob rejects at parse rather than deep inside verification.
 */

/**
 * A base64url string constrained to an exact or minimum DECODED byte length (R3-4). Validation only —
 * the wire form stays the (validated) string; `authCrypto` decodes to bytes where it needs them.
 */
function base64urlBytes(constraint: { exact: number } | { min: number }): z.ZodEffects<z.ZodString, string, string> {
  return z.string().superRefine((value, ctx) => {
    let bytes: Uint8Array;
    try {
      bytes = base64urlDecodeStrict(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be canonical unpadded base64url' });
      return;
    }
    if ('exact' in constraint && bytes.length !== constraint.exact) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must decode to exactly ${constraint.exact} bytes` });
    }
    if ('min' in constraint && bytes.length < constraint.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must decode to at least ${constraint.min} bytes` });
    }
  });
}

/** Ed25519 public key — exactly 32 bytes. */
export const SigningPublicKeySchema = base64urlBytes({ exact: 32 });
/** Ed25519 signature — exactly 64 bytes. */
export const SignatureSchema = base64urlBytes({ exact: 64 });
/** Challenge nonce / opaque token floor — ≥ 32 bytes of entropy. */
export const NonceSchema = base64urlBytes({ min: 32 });
/** Server-issued challenge handle — high-entropy, ≥ 32 bytes. */
export const ChallengeIdSchema = base64urlBytes({ min: 32 });

const KeyIdSchema = z.string().min(1);
const DeviceLabelSchema = z.string().min(1).max(128);

/** The signing-purpose enum, single-sourced from {@link AUTH_PURPOSES} so wire ↔ TLV cannot diverge. */
export const AuthPurposeSchema = z.enum(AUTH_PURPOSES);

/**
 * The shared signed-request base: a challenge handle plus the signature over the matching canonical
 * TLV. Every signed wire request extends this; `purpose` is NEVER a trusted body field (the endpoint
 * pins its constant and the TLV binds it — R3-2 / secSys Ask-2).
 */
const signedRequestShape = {
  challengeId: ChallengeIdSchema,
  signature: SignatureSchema,
} as const;

/** `POST /api/auth/challenge` — mint a challenge of `purpose`. `keyId` is absent for `register`. */
export const ChallengeRequestSchema = z
  .object({ keyId: KeyIdSchema.optional(), purpose: AuthPurposeSchema })
  .strict();
export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

export const ChallengeResponseSchema = z
  .object({
    challengeId: ChallengeIdSchema,
    nonce: NonceSchema,
    expiresAt: z.string(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

/** `POST /api/auth/register` — `signature` (the register-TLV proof) doubles as the device authorization. */
export const RegisterDeviceRequestSchema = z
  .object({
    ...signedRequestShape,
    signingPublicKey: SigningPublicKeySchema,
    deviceLabel: DeviceLabelSchema,
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

/** `POST /api/auth/session` — the only signed request-supplied field is `requestedScope` (clamped at mint, F5). */
export const SessionRequestSchema = z
  .object({
    ...signedRequestShape,
    keyId: KeyIdSchema,
    requestedScope: z.array(ScopeSchema).min(1),
  })
  .strict();
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/** Step-up for an F9 sensitive op — binds the verified `(op, resource)` the signature was made over. */
export const StepUpRequestSchema = z
  .object({
    ...signedRequestShape,
    keyId: KeyIdSchema,
    op: OpSchema,
    resource: ResourceSchema,
  })
  .strict();
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>;
