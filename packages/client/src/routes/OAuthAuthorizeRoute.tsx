/**
 * OAuthAuthorizeRoute — `/oauth/authorize`, the PWA-mediated OAuth consent screen (oauth-provider.md §2b).
 *
 * An OAuth/MCP client (Claude) opens this route with the authorization params in the query string. The PWA
 * loads, does its normal ungated reload-auth (→ in-memory bearer), and renders an HONEST consent screen:
 *   - it names the app by the destination it will return to (the redirect_uri HOST — the anti-phishing
 *     signal: "Access will be sent to: claude.ai") + the client_id, since client_name is NOT in the query;
 *   - it discloses the EXACT access granted — READ-ONLY (scopes: read, search), never write;
 *   - Approve re-proves the human (STEP-UP: password always, + TOTP when 2FA is on — the same bar as
 *     agent-token mint), POSTs to the JSON `POST /api/oauth/authorize`, and on success does a top-level
 *     navigation to `redirect_uri?code&state` (that navigation IS the OAuth redirect);
 *   - Deny navigates to `redirect_uri?error=access_denied&state`.
 *
 * If there is no live session, the user is bounced through the app's normal login and returned here with the
 * params intact (setOAuthReturn / consumeOAuthReturn) — no new auth path. Invalid/missing params or a non-
 * S256 code_challenge_method are refused BEFORE any POST (a clear terminal error, no redirect).
 *
 * RESIDENCY: `lazy()`-loaded in App.tsx (its own chunk), so neither this screen nor its network client
 * (oauthClient) ever touches the mobile first-load bundle (CONV-0004 / plugins-lazy-past-first-paint).
 */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import type { AuthorizeConsentRequest } from '@deltos/shared';
import { useAuthStore } from '../auth/store.js';
import { mintConsentCode, OAuthClientError } from '../lib/oauthClient.js';
import { setOAuthReturn } from '../lib/oauthReturn.js';

/** The read-only scopes an OAuth v1 grant carries — surfaced verbatim on the consent screen. */
const DISCLOSED_SCOPES = ['read', 'search'] as const;

/** The validated authorize params pulled from the query string (null = invalid request). */
interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  redirectHost: string;
  codeChallenge: string;
  scope?: string | undefined;
  resource?: string | undefined;
  state?: string | undefined;
}

/**
 * Parse + validate the OAuth query params. Returns the params on success, or an error MESSAGE naming the
 * fault. PKCE S256 is mandatory (a `plain`/missing method is refused here, before any POST); the redirect
 * must be an absolute URL (so we can show its host + safely navigate to it).
 */
function parseParams(sp: URLSearchParams): { ok: true; params: AuthorizeParams } | { ok: false; message: string } {
  const clientId = sp.get('client_id') ?? '';
  const redirectUri = sp.get('redirect_uri') ?? '';
  const codeChallenge = sp.get('code_challenge') ?? '';
  const method = sp.get('code_challenge_method') ?? '';

  if (!clientId) return { ok: false, message: 'This authorization request is missing its client_id.' };
  if (!redirectUri) return { ok: false, message: 'This authorization request is missing its redirect_uri.' };
  if (!codeChallenge) return { ok: false, message: 'This authorization request is missing its PKCE code challenge.' };
  if (method !== 'S256') {
    return { ok: false, message: 'This app requested an unsupported security method. deltos requires PKCE S256.' };
  }

  let redirectHost: string;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    return { ok: false, message: 'This authorization request has an invalid redirect_uri.' };
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      redirectHost,
      codeChallenge,
      scope: sp.get('scope') ?? undefined,
      resource: sp.get('resource') ?? undefined,
      state: sp.get('state') ?? undefined,
    },
  };
}

/** Top-level navigation = the OAuth redirect. Split out so tests can stub the assign. */
function redirectTo(url: string): void {
  window.location.assign(url);
}

/**
 * Build the OAuth redirect URL by appending params through the URL API — NOT string concatenation. This
 * correctly handles a redirect_uri that already carries a query string (append with `&`, not a second `?`)
 * and URL-encodes client-controlled values (notably `state`, which may hold reserved characters). Only ever
 * called with a SERVER-VALIDATED redirect_uri (the echo from a successful mint), so `new URL` is safe.
 */
function buildRedirect(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

type Phase =
  | { tag: 'consent'; password: string; totp: string; error: string | null }
  | { tag: 'submitting' }
  | { tag: 'redirecting' }
  | { tag: 'denied' };

export function OAuthAuthorizeRoute() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const isAuthed = useAuthStore((s) => s.isAuthed);
  const sessionState = useAuthStore((s) => s.sessionState);
  const totpEnabled = useAuthStore((s) => s.totpEnabled);
  const requireReauth = useAuthStore((s) => s.requireReauth);

  const parsed = useMemo(() => parseParams(searchParams), [searchParams]);
  const [phase, setPhase] = useState<Phase>({ tag: 'consent', password: '', totp: '', error: null });

  // 'revoked' = isAuthed is persisted-true (ungated local shell) but the refresh cookie is DEAD in this
  // browser context, so there is no live bearer and a consent POST would 503. Force a full re-login here
  // (requireReauth is non-destructive — it keeps local data), stashing the return so login lands back on
  // consent. This is the common real case: the OAuth client opens consent in a context without a live session.
  useEffect(() => {
    if (parsed.ok && isAuthed === true && sessionState === 'revoked') {
      setOAuthReturn(location.pathname + location.search);
      requireReauth();
    }
  }, [parsed.ok, isAuthed, sessionState, location, requireReauth]);

  // ── Invalid request — refuse before any auth / POST (a clear terminal error, no redirect). ──
  if (!parsed.ok) {
    return (
      <div className="auth">
        <div className="auth__logo">δ</div>
        <h1 className="auth__title">Can’t authorize this app</h1>
        <p className="auth__subtitle">{parsed.message}</p>
      </div>
    );
  }
  const p = parsed.params;

  // ── Auth gate — reuse the app's EXISTING login; return here afterward. ──
  // null = boot /refresh still resolving → neutral hold; false = no session → stash + bounce to login.
  if (isAuthed === null) {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }
  if (isAuthed === false) {
    setOAuthReturn(location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  // Revoked session (dead cookie in this context): the effect above is flipping us to the login gate — hold
  // a spinner rather than flash the consent screen or fire an unauthenticated (503) POST.
  if (sessionState === 'revoked') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Signing in again" />
      </div>
    );
  }

  // Deny → a TERMINAL screen, NOT a navigation. We can't validate the query-string redirect_uri client-side
  // (only the server knows the client's registered URIs), so bouncing the browser to it would be an open
  // redirect on an attacker-crafted request. To an OAuth client a deny and an abandoned tab are identical, so
  // simply not redirecting is a safe, correct deny. (Approve only ever navigates to the server-validated echo.)
  const deny = () => setPhase({ tag: 'denied' });

  const approve = async () => {
    if (phase.tag !== 'consent') return;
    if (!phase.password) {
      setPhase({ ...phase, error: 'Enter your password to authorize this app.' });
      return;
    }
    const totp = phase.totp.trim();
    setPhase({ tag: 'submitting' });
    const body: AuthorizeConsentRequest = {
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      password: phase.password,
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.resource ? { resource: p.resource } : {}),
      ...(p.state !== undefined ? { state: p.state } : {}),
      ...(totp ? { totp } : {}),
    };
    try {
      const res = await mintConsentCode(body);
      // Success — perform the OAuth redirect. Keep a spinner up; the browser is leaving the app. The
      // redirect_uri is the server-validated echo, so building the URL from it is safe.
      setPhase({ tag: 'redirecting' });
      redirectTo(buildRedirect(res.redirect_uri, { code: res.code, state: res.state }));
    } catch (err) {
      // Session died between mount and submit (e.g. access TTL lapsed mid-consent + the refresh cookie is
      // dead in this context) → route into a full re-login (non-destructive), returning here after.
      if (err instanceof OAuthClientError && err.code === 'session_revoked') {
        setOAuthReturn(location.pathname + location.search);
        requireReauth();
        return;
      }
      // Step-up failure (401) → stay on the consent screen with an inline error so the entered factors can
      // be corrected and retried; anything else → surface the message on the same screen.
      const message =
        err instanceof OAuthClientError ? err.message : 'Something went wrong — try again.';
      setPhase({ tag: 'consent', password: phase.password, totp: phase.totp, error: message });
    }
  };

  if (phase.tag === 'redirecting') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Redirecting…" />
        <p className="auth__subtitle">Returning you to {p.redirectHost}…</p>
      </div>
    );
  }

  if (phase.tag === 'denied') {
    return (
      <div className="auth" aria-label="Access denied">
        <div className="auth__logo">δ</div>
        <h1 className="auth__title">Access denied</h1>
        <p className="auth__subtitle">
          You didn’t authorize {p.redirectHost}. Nothing was shared. You can close this window.
        </p>
      </div>
    );
  }

  const busy = phase.tag === 'submitting';

  return (
    <div className="auth" aria-label="Authorize app">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Authorize access to your notes</h1>

      {/* Anti-phishing disclosure: name the app by WHERE the access is sent (redirect host) + its id. */}
      <div className="oauth-consent__card">
        <p className="oauth-consent__lede">An app is asking to connect to your deltos notes.</p>
        <p className="oauth-consent__sent">
          Access will be sent to:{' '}
          <strong className="oauth-consent__host">{p.redirectHost}</strong>
        </p>
        <p className="oauth-consent__client">App ID: {p.clientId}</p>
        <div className="oauth-consent__scopes">
          <span className="oauth-consent__scopes-title">This app will get read-only access:</span>
          <ul className="oauth-consent__scope-list">
            {DISCLOSED_SCOPES.map((s) => (
              <li key={s} className="oauth-consent__scope">
                {s === 'read' ? 'Read your notes' : 'Search your notes'} ({s})
              </li>
            ))}
          </ul>
          <p className="oauth-consent__scopes-note">
            It can’t create, edit, or delete anything. You can disconnect it anytime in Settings.
          </p>
        </div>
      </div>

      {/* Step-up: re-prove the human before granting (password always; TOTP when 2FA is on). */}
      {phase.tag === 'consent' && (
        <>
          <input
            className="auth__input"
            type="password"
            value={phase.password}
            onChange={(e) => setPhase({ ...phase, password: e.target.value, error: null })}
            placeholder="Your password"
            aria-label="Your password"
            autoComplete="current-password"
            disabled={busy}
            autoFocus
          />
          {totpEnabled && (
            <input
              className="auth__input"
              type="text"
              inputMode="numeric"
              value={phase.totp}
              onChange={(e) => setPhase({ ...phase, totp: e.target.value.replace(/\D/g, ''), error: null })}
              placeholder="Two-factor code"
              aria-label="Two-factor code"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={busy}
            />
          )}
          {phase.error && <p className="auth__error">{phase.error}</p>}
        </>
      )}

      <button
        className="auth__btn auth__btn--primary"
        onClick={() => void approve()}
        disabled={busy}
        aria-label="Authorize"
      >
        {busy ? 'Authorizing…' : 'Authorize'}
      </button>
      <button className="auth__btn" onClick={deny} disabled={busy} aria-label="Deny">
        Deny
      </button>
    </div>
  );
}
