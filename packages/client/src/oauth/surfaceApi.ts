/**
 * Network layer for the SEPARATE OAuth authorization surface (oauth-consent-surface-separation.md).
 *
 * Self-contained auth: this surface does NOT use the app's auth store (which is coupled to the notes boot /
 * sync). It talks to the SAME endpoints directly —
 *   - `refreshBearer()`  — POST /api/auth/refresh (the httpOnly refresh cookie rides same-origin) to re-mint
 *     an in-memory access token when the browser already holds a live deltos session.
 *   - `login()`          — POST /api/auth/login for the common case where the OAuth client opened consent in
 *     a context with NO live session (different browser / webclip isolation / dead cookie).
 *   - `mintConsentCode()`— POST /api/oauth/authorize (bearer + step-up) to mint the authorization code.
 *
 * The bearer never persists — it lives only in the OAuthApp component's memory for the duration of the
 * consent, exactly like the app's in-memory access token. No refresh cookie is set here (login only Set-
 * Cookies at /finalize, which is the app's ceremony); we just need a live bearer to authorize the grant.
 */
import type {
  AccessTokenResponse,
  AuthorizeConsentRequest,
  AuthorizeConsentResponse,
} from '@deltos/shared';

/** A live session minted on this surface — the fields the consent flow needs. */
export interface SurfaceSession {
  bearer: string;
  totpEnabled: boolean;
}

export type LoginOutcome =
  | { ok: true; session: SurfaceSession }
  | { ok: false; code: 'invalid' | 'totp_required' | 'totp_invalid' | 'rate_limited' | 'network' };

function sessionFrom(s: AccessTokenResponse): SurfaceSession {
  return { bearer: s.token, totpEnabled: s.totpEnabled === true };
}

/**
 * Ride the httpOnly refresh cookie (same-origin, auto-attached) to re-mint an access token. Returns the
 * session when a live deltos session exists in this browser context, or null (401/other/network) when it
 * doesn't — the caller then shows the inline login.
 */
export async function refreshBearer(): Promise<SurfaceSession | null> {
  let res: Response;
  try {
    res = await fetch('/api/auth/refresh', { method: 'POST' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return sessionFrom((await res.json()) as AccessTokenResponse);
  } catch {
    return null;
  }
}

/** Username + password (+ optional TOTP + Turnstile). Uniform 'invalid' on any wrong credential. */
export async function login(
  username: string,
  password: string,
  totp?: string,
  turnstileToken?: string,
): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        ...(totp ? { totp } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (!res.ok) {
    if (res.status === 429) return { ok: false, code: 'rate_limited' };
    const raw = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    const c = raw.error?.code;
    if (c === 'totp_required') return { ok: false, code: 'totp_required' };
    if (c === 'totp_invalid') return { ok: false, code: 'totp_invalid' };
    return { ok: false, code: 'invalid' }; // uniform — no username enumeration
  }
  try {
    return { ok: true, session: sessionFrom((await res.json()) as AccessTokenResponse) };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/** A failed consent mint, carrying the HTTP status + server error code (for step-up field targeting). */
export class ConsentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

/** Turn a step-up error code (or none) into a human message keyed to the field at fault. */
function stepUpMessage(code?: string): string {
  switch (code) {
    case 'password_required':
      return 'Enter your password to authorize this app.';
    case 'password_invalid':
      return 'That password is incorrect.';
    case 'totp_required':
      return 'Enter your two-factor code.';
    case 'totp_invalid':
      return 'That two-factor code is not valid.';
    default:
      return 'Re-authentication failed — check your password and try again.';
  }
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Mint the OAuth authorization code at consent (POST /api/oauth/authorize). Bearer-authed + STEP-UP
 * (`password` always; `totp` when 2FA is on) — the server re-proves the human, exactly like agent-token
 * mint. On success returns `{ code, redirect_uri, state? }`; the caller then top-level-navigates the browser
 * to `redirect_uri?code&state` (that navigation IS the OAuth redirect). A step-up failure (401) surfaces as
 * a ConsentError so the screen can target the right field and retry; a 400 means the app's request is
 * invalid (unknown client / unregistered redirect) — a config error, not a retryable step-up.
 */
export async function mintConsentCode(
  bearer: string,
  params: AuthorizeConsentRequest,
): Promise<AuthorizeConsentResponse> {
  let res: Response;
  try {
    res = await fetch('/api/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(params),
    });
  } catch {
    throw new ConsentError('Could not reach the server — check your connection.');
  }
  if (res.status === 401) {
    const code = await readErrorCode(res);
    throw new ConsentError(stepUpMessage(code), 401, code);
  }
  if (res.status === 403 || res.status === 503) {
    // The bearer lapsed between refresh/login and submit → the session must be re-established. On this
    // surface there is no silent re-mint (no store); surface it so the flow can drop back to login.
    throw new ConsentError('Your session expired — sign in again to continue.', res.status, 'session_expired');
  }
  if (res.status === 400) {
    throw new ConsentError('This app’s authorization request is invalid — it may be misconfigured.', 400);
  }
  if (res.status === 429) {
    throw new ConsentError('Too many attempts — wait a moment and try again.', 429);
  }
  if (!res.ok) throw new ConsentError(`Could not authorize the app (${res.status}).`, res.status);
  return (await res.json()) as AuthorizeConsentResponse;
}
