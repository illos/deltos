import { z } from 'zod';

/**
 * The DIRECTORY layer (D6 account-identity): a unique human alias → `accountId`. This module owns the
 * PURE normalization + validation that decides the uniqueness key, shared byte-for-byte by the client
 * (pre-claim hinting) and the worker claim endpoint so the two can never disagree on what "taken" means.
 *
 * THE TWO LOAD-BEARING RULES (docs/design/secSys-account-identity-review.md S1, strawman §2):
 *  1. Uniqueness is decided on the NORMALIZED form (NFKC -> casefold -> trim). `Alice`, `alice`, `ALICE`,
 *     and the fullwidth `ＡＬＩＣＥ` collapse to ONE claim, so a casing/compatibility variant cannot race
 *     the atomic-unique INSERT in the store.
 *  2. Conservative charset `[a-z0-9_-]`, 3-32, must start alphanumeric — kills confusables/homoglyphs at
 *     the boundary (a Cyrillic "a" or a fullwidth digit never reaches the uniqueness key). Zero-width /
 *     control chars are rejected EXPLICITLY (not silently stripped), so a hidden character can never
 *     smuggle a visually-distinct second claim past the fold.
 *
 * INVARIANT (i): this layer is a LABEL, never an authenticator. Nothing here keys authorization — the
 * endpoint binds the claim to the authenticated `principal.id` (= `accountId`), never to the username.
 */

/** The normalized (uniqueness key) + display (as-typed) pair a successful claim records. */
export interface UsernameNormalized {
  /** As-typed within the charset, trimmed — what the UI shows. */
  display: string;
  /** NFKC + casefold + trim — THE uniqueness key the store's UNIQUE constraint arbitrates. */
  normalized: string;
}

/** Why a raw username was refused. The endpoint maps each to a 400 with a stable, non-leaky message. */
export type UsernameRejectReason =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'charset'
  | 'leading'
  | 'control'
  | 'reserved';

export type NormalizeUsernameResult =
  | { ok: true; value: UsernameNormalized }
  | { ok: false; reason: UsernameRejectReason };

/** Min/max on the NORMALIZED form (decoded, post-fold), not the wire byte length. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Reserved directory names refused at claim time (lowercase, matched against the normalized form).
 * Conservative v1 set: administrative handles, impersonation-bait service names, and the principal
 * pseudo-ids (`me`/`self`/`owner`/`anonymous`/`guest`) so a directory entry can never shadow one.
 */
export const USERNAME_RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'sys',
  'support',
  'help',
  'helpdesk',
  'info',
  'contact',
  'api',
  'deltos',
  'official',
  'security',
  'abuse',
  'postmaster',
  'webmaster',
  'hostmaster',
  'noreply',
  'no-reply',
  'mod',
  'moderator',
  'staff',
  'team',
  'owner',
  'me',
  'self',
  'null',
  'undefined',
  'anonymous',
  'guest',
  'everyone',
  'all',
]);

// Zero-width + control chars that survive NFKC and must be rejected explicitly (never stripped):
// C0/C1 controls, zero-width space/joiners (U+200B-U+200D), word joiner (U+2060), BOM/ZWNBSP (U+FEFF).
const CONTROL_OR_ZERO_WIDTH = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/;
const CHARSET = /^[a-z0-9_-]+$/;
const STARTS_ALNUM = /^[a-z0-9]/;

/**
 * Decide a raw username's normalized uniqueness key + display form, or reject with a typed reason.
 * PURE: no I/O. The endpoint runs THIS (never a second, divergent rule) and then performs the atomic
 * claim on `value.normalized`. Order of checks is fixed so the reason is deterministic.
 */
export function normalizeUsername(raw: string): NormalizeUsernameResult {
  // NFKC first (folds fullwidth -> ASCII, NBSP -> space), then trim outer whitespace.
  const trimmed = raw.normalize('NFKC').trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  // Explicit reject BEFORE folding/charset so a hidden char is a distinct, honest failure — not a
  // silently-stripped one that would let two visually-distinct strings fold to one claim.
  if (CONTROL_OR_ZERO_WIDTH.test(trimmed)) return { ok: false, reason: 'control' };

  const normalized = trimmed.toLowerCase(); // casefold (ASCII charset ⇒ toLowerCase is the full fold)

  if (normalized.length < USERNAME_MIN_LENGTH) return { ok: false, reason: 'too-short' };
  if (normalized.length > USERNAME_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  if (!CHARSET.test(normalized)) return { ok: false, reason: 'charset' };
  if (!STARTS_ALNUM.test(normalized)) return { ok: false, reason: 'leading' };
  if (USERNAME_RESERVED.has(normalized)) return { ok: false, reason: 'reserved' };

  return { ok: true, value: { display: trimmed, normalized } };
}

/**
 * `POST /api/auth/username` — the authenticated claim body. `.strict()` (fail-closed) is INVARIANT (i)
 * at the wire: a body-supplied `accountId` (or any other field) REJECTS, so the only account a claim can
 * bind to is the authenticated `principal.id` the endpoint reads server-side. The coarse `max` is a
 * pre-normalization guard against an oversized blob; `normalizeUsername` enforces the real 3-32 bound.
 */
export const UsernameClaimRequestSchema = z
  .object({
    username: z.string().min(1).max(128),
  })
  .strict();
export type UsernameClaimRequest = z.infer<typeof UsernameClaimRequestSchema>;

/** `201` body of a successful claim — echoes the stored display form (never an accountId). */
export const UsernameClaimResponseSchema = z.object({ username: z.string().min(1) }).strict();
export type UsernameClaimResponse = z.infer<typeof UsernameClaimResponseSchema>;
