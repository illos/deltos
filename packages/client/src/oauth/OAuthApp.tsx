/**
 * OAuthApp — the SEPARATE OAuth authorization surface (oauth-consent-surface-separation.md / DEC-0005),
 * served at `/oauth/authorize`. An OAuth/MCP client (Claude) opens this URL with the authorization params
 * in the query string. Unlike the retired PWA-mediated consent route, this is a standalone app: it has NO
 * react-router, NO app boot store, NO service worker — just its own session acquisition + consent.
 *
 * Flow:
 *   1. Parse + validate the query params (PKCE S256 mandatory). Invalid → a terminal error, no redirect.
 *   2. Acquire a session: POST /api/auth/refresh (rides the httpOnly cookie if this browser holds a live
 *      deltos session); if none, show an inline login (username + password + Turnstile + TOTP). The common
 *      case here is NO live session — the client opened consent in a fresh browser context.
 *   3. Consent: an HONEST disclosure — names the app by the redirect_uri HOST (anti-phishing) + client_id,
 *      discloses the EXACT scopes (read-only by default; an optional WRITE toggle — same mechanism + default
 *      as the manual mint route — flips the disclosure to name write access). Approve re-proves the human
 *      (STEP-UP: password always; a fresh
 *      TOTP code when 2FA is on — reusing the login password silently, but never a stale TOTP), POSTs to
 *      /api/oauth/authorize, and top-level-navigates to `redirect_uri?code&state` (that IS the OAuth
 *      redirect). Deny is a TERMINAL screen (never navigate to an unvalidated redirect_uri).
 */
import { useEffect, useRef, useState } from 'react';
import type { AuthorizeConsentRequest } from '@deltos/shared';
import { Turnstile, turnstileEnabled, type TurnstileHandle } from '../components/Turnstile.js';
import {
  ConsentError,
  login as apiLogin,
  mintConsentCode,
  refreshBearer,
  type SurfaceSession,
} from './surfaceApi.js';

/** The read-only scopes an OAuth v1 grant carries — surfaced verbatim on the consent screen. */
const DISCLOSED_SCOPES = ['read', 'search'] as const;

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
 * Parse + validate the OAuth query params. PKCE S256 is mandatory (a `plain`/missing method is refused
 * before any POST); the redirect must be an absolute URL so we can show its host + safely navigate to it.
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
 * Build the OAuth redirect URL through the URL API (not string concat) so a redirect_uri that already
 * carries a query string is appended correctly and client-controlled values (notably `state`) are encoded.
 * Only ever called with the SERVER-VALIDATED redirect_uri echo, so `new URL` is safe.
 */
function buildRedirect(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function TerminalScreen({ title, message, label }: { title: string; message: string; label?: string }) {
  return (
    <div className="auth" aria-label={label ?? title}>
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">{title}</h1>
      <p className="auth__subtitle">{message}</p>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="auth">
      <div className="auth__spinner" aria-label={label} />
    </div>
  );
}

// ── Inline login ────────────────────────────────────────────────────────────────────────────────────────

function loginErrorMsg(code: 'invalid' | 'totp_invalid' | 'rate_limited' | 'network'): string {
  switch (code) {
    case 'invalid': return 'Incorrect username or password';
    case 'totp_invalid': return 'Incorrect authentication code';
    case 'rate_limited': return 'Too many attempts — please wait a moment';
    case 'network': return 'Connection error — please try again';
  }
}

type LoginStep =
  | { tag: 'form'; error?: string }
  | { tag: 'busy' }
  | { tag: 'totp'; code: string; error?: string; submitting: boolean };

/**
 * Self-contained login — username + password (+ Turnstile + optional TOTP). On success hands the caller the
 * session AND the entered password (for silent step-up reuse at consent — passwords aren't single-use; the
 * TOTP is NOT carried, since a step-up needs a fresh code).
 */
function LoginScreen({ onSuccess }: { onSuccess: (session: SurfaceSession, password: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle | null>(null);
  const [step, setStep] = useState<LoginStep>({ tag: 'form' });

  const submit = (totpCode?: string) => {
    setStep(totpCode !== undefined ? { tag: 'totp', code: totpCode, submitting: true } : { tag: 'busy' });
    apiLogin(username.trim(), password, totpCode, turnstileToken ?? undefined)
      .then((r) => {
        // A spent Turnstile token is single-use — re-challenge on any non-success so a retry carries a fresh one.
        if (!r.ok) turnstileRef.current?.reset();
        if (r.ok) { onSuccess(r.session, password); return; }
        if (r.code === 'totp_required') { setStep({ tag: 'totp', code: '', submitting: false }); return; }
        const msg = loginErrorMsg(r.code);
        setStep((prev) => (prev.tag === 'totp'
          ? { tag: 'totp', code: prev.code, submitting: false, error: msg }
          : { tag: 'form', error: msg }));
      })
      .catch(() => setStep((prev) => (prev.tag === 'totp'
        ? { tag: 'totp', code: prev.code, submitting: false, error: 'Connection error — please try again' }
        : { tag: 'form', error: 'Connection error — please try again' })));
  };

  if (step.tag === 'busy') return <Spinner label="Signing in" />;

  if (step.tag === 'totp') {
    return (
      <div className="auth">
        <h1 className="auth__title">Enter your authentication code</h1>
        <p className="auth__subtitle">Open your authenticator app and enter the 6-digit code.</p>
        <input
          className="auth__input auth__totp-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={step.code}
          onChange={(e) => setStep({ tag: 'totp', code: e.target.value.replace(/\D/g, ''), submitting: false })}
          aria-label="6-digit authentication code"
          disabled={step.submitting}
          autoFocus
        />
        {step.error && <p className="auth__error">{step.error}</p>}
        <Turnstile ref={turnstileRef} onToken={setTurnstileToken} />
        <button
          className="auth__btn auth__btn--primary"
          onClick={() => submit(step.code)}
          disabled={step.code.length < 6 || step.submitting || (turnstileEnabled && !turnstileToken)}
        >
          {step.submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button className="auth__link" onClick={() => setStep({ tag: 'form' })}>Back</button>
      </div>
    );
  }

  const canSubmit = username.trim() && password && !(turnstileEnabled && !turnstileToken);
  return (
    <div className="auth">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Sign in to authorize</h1>
      <p className="auth__subtitle">Sign in to your deltos account to review this request.</p>

      <input
        className="auth__input"
        type="text"
        value={username}
        onChange={(e) => { setUsername(e.target.value); if (step.error) setStep({ tag: 'form' }); }}
        placeholder="Username"
        autoCapitalize="none"
        autoComplete="username"
        aria-label="Username"
      />
      <input
        className="auth__input"
        type="password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); if (step.error) setStep({ tag: 'form' }); }}
        placeholder="Password"
        autoComplete="current-password"
        aria-label="Password"
        onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
      />
      {step.error && <p className="auth__error">{step.error}</p>}
      <Turnstile ref={turnstileRef} onToken={setTurnstileToken} />
      <button className="auth__btn auth__btn--primary" onClick={() => submit()} disabled={!canSubmit}>
        Sign in
      </button>
    </div>
  );
}

// ── Consent ─────────────────────────────────────────────────────────────────────────────────────────────

type ConsentPhase = 'idle' | 'submitting' | 'redirecting' | 'denied';

/**
 * The approve/deny consent screen — rendered once a session (bearer) is held. `carriedPassword` is present
 * when the session came from the inline login (reuse it silently for the step-up); absent when it came from
 * the refresh cookie (collect the password fresh). A fresh TOTP code is always collected when 2FA is on.
 */
function ConsentScreen({
  params,
  session,
  carriedPassword,
  onExpired,
}: {
  params: AuthorizeParams;
  session: SurfaceSession;
  carriedPassword: string | undefined;
  onExpired: () => void;
}) {
  const [password, setPassword] = useState(carriedPassword ?? '');
  const [totp, setTotp] = useState('');
  // WRITE opt-in — default OFF (read-only), the SAME default + mechanism as the manual mint toggle. When on,
  // the consent POSTs `write` and the disclosure below switches to name the write access honestly.
  const [allowWrite, setAllowWrite] = useState(false);
  // Reveal the password field when we didn't carry one from a just-completed login (or after an error, so a
  // wrong carried password can be corrected).
  const [revealPassword, setRevealPassword] = useState(!carriedPassword);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConsentPhase>('idle');

  const approve = async () => {
    if (phase !== 'idle') return;
    if (revealPassword && !password) { setError('Enter your password to authorize this app.'); return; }
    const code = totp.trim();
    if (session.totpEnabled && !code) { setError('Enter your two-factor code.'); return; }
    setPhase('submitting');
    setError(null);
    const body: AuthorizeConsentRequest = {
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      password,
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.resource ? { resource: params.resource } : {}),
      ...(params.state !== undefined ? { state: params.state } : {}),
      ...(code ? { totp: code } : {}),
      // A single toggle grants the full write surface (create + edit + trash) — matches the manual mint UI.
      ...(allowWrite ? { write: { create: true, update: true, trash: true } } : {}),
    };
    try {
      const res = await mintConsentCode(session.bearer, body);
      setPhase('redirecting');
      redirectTo(buildRedirect(res.redirect_uri, { code: res.code, state: res.state }));
    } catch (err) {
      // Session died between acquisition and submit → drop back to a fresh login (nothing was granted).
      if (err instanceof ConsentError && err.code === 'session_expired') { onExpired(); return; }
      const message = err instanceof ConsentError ? err.message : 'Something went wrong — try again.';
      setRevealPassword(true); // let the user correct the password/2FA and retry
      setPhase('idle');
      setError(message);
    }
  };

  if (phase === 'redirecting') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Redirecting…" />
        <p className="auth__subtitle">Returning you to {params.redirectHost}…</p>
      </div>
    );
  }

  if (phase === 'denied') {
    return (
      <TerminalScreen
        label="Access denied"
        title="Access denied"
        message={`You didn’t authorize ${params.redirectHost}. Nothing was shared. You can close this window.`}
      />
    );
  }

  const busy = phase === 'submitting';
  return (
    <div className="auth" aria-label="Authorize app">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Authorize access to your notes</h1>

      {/* Anti-phishing disclosure: name the app by WHERE the access is sent (redirect host) + its id. */}
      <div className="oauth-consent__card">
        <p className="oauth-consent__lede">An app is asking to connect to your deltos notes.</p>
        <p className="oauth-consent__sent">
          Access will be sent to:{' '}
          <strong className="oauth-consent__host">{params.redirectHost}</strong>
        </p>
        <p className="oauth-consent__client">App ID: {params.clientId}</p>
        <div className="oauth-consent__scopes">
          <span className="oauth-consent__scopes-title">
            {allowWrite ? 'This app will get read & write access:' : 'This app will get read-only access:'}
          </span>
          <ul className="oauth-consent__scope-list">
            {DISCLOSED_SCOPES.map((s) => (
              <li key={s} className="oauth-consent__scope">
                {s === 'read' ? 'Read your notes' : 'Search your notes'} ({s})
              </li>
            ))}
            {allowWrite && (
              <li className="oauth-consent__scope">Create, edit &amp; delete notes (create, write, delete)</li>
            )}
          </ul>
          <p className="oauth-consent__scopes-note">
            {allowWrite
              ? 'Deletes go to Trash and are recoverable. You can disconnect it anytime in Settings.'
              : 'It can’t create, edit, or delete anything. You can disconnect it anytime in Settings.'}
          </p>
        </div>
      </div>

      {/* WRITE opt-in — default OFF; the same choice + copy as the manual mint UI so both surfaces read as
          one mechanism. Toggling it re-writes the disclosure above so consent stays honest. */}
      <label className="oauth-consent__write-toggle">
        <input
          type="checkbox"
          checked={allowWrite}
          onChange={(e) => { setAllowWrite(e.target.checked); setError(null); }}
          disabled={busy}
          aria-label="Allow this app to create, edit and delete notes"
        />
        <span>
          Allow this app to <strong>create, edit &amp; delete</strong> notes (deletes go to Trash and are
          recoverable). Leave off for read-only access.
        </span>
      </label>

      {/* Step-up: re-prove the human before granting (password always; a fresh TOTP when 2FA is on). */}
      {revealPassword && (
        <input
          className="auth__input"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          placeholder="Your password"
          aria-label="Your password"
          autoComplete="current-password"
          disabled={busy}
          autoFocus
        />
      )}
      {session.totpEnabled && (
        <input
          className="auth__input"
          type="text"
          inputMode="numeric"
          value={totp}
          onChange={(e) => { setTotp(e.target.value.replace(/\D/g, '')); setError(null); }}
          placeholder="Two-factor code"
          aria-label="Two-factor code"
          autoComplete="one-time-code"
          maxLength={6}
          disabled={busy}
        />
      )}
      {error && <p className="auth__error">{error}</p>}

      <button
        className="auth__btn auth__btn--primary"
        onClick={() => void approve()}
        disabled={busy}
        aria-label="Authorize"
      >
        {busy ? 'Authorizing…' : 'Authorize'}
      </button>
      <button className="auth__btn" onClick={() => setPhase('denied')} disabled={busy} aria-label="Deny">
        Deny
      </button>
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────────────────────────────────

type Session = { session: SurfaceSession; carriedPassword: string | undefined };

export function OAuthApp() {
  // Params are fixed for the life of the page (a top-level navigation carries them); parse once.
  const [parsed] = useState(() => parseParams(new URLSearchParams(window.location.search)));
  // null = still acquiring (booting refresh); else the live session + any carried login password.
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!parsed.ok) { setBooting(false); return; }
    let cancelled = false;
    void refreshBearer().then((s) => {
      if (cancelled) return;
      if (s) setSession({ session: s, carriedPassword: undefined });
      setBooting(false);
    });
    return () => { cancelled = true; };
  }, [parsed.ok]);

  if (!parsed.ok) {
    return <TerminalScreen label="Can’t authorize this app" title="Can’t authorize this app" message={parsed.message} />;
  }
  if (booting) return <Spinner label="Loading" />;
  if (!session) {
    return <LoginScreen onSuccess={(s, password) => setSession({ session: s, carriedPassword: password })} />;
  }
  return (
    <ConsentScreen
      params={parsed.params}
      session={session.session}
      carriedPassword={session.carriedPassword}
      // Session expired mid-consent → clear it and fall back to a fresh login with the params intact.
      onExpired={() => setSession(null)}
    />
  );
}
