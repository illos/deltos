/**
 * LoginRoute — username + password (+ optional TOTP) authentication.
 *
 * P0 LATCH: beginAuth() at ceremony start; finalizeAuth() only on ok + no recoveryRequired.
 * The latch pins the gate to this route — the shell never opens at an intermediate step.
 *
 * recoveryRequired=true (P0-belt): login succeeded but the account never finalized a phrase.
 * Navigate to /forced-phrase (still within auth-gate, isAuthing=true pins it); finalizeAuth
 * waits until the phrase is saved+acked there.
 *
 * Uniform error on invalid credentials (no username enumeration). totp_required triggers the
 * inline TOTP field; the route re-calls login(username, password, code) with the code.
 */
import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import type { LoginResult } from '../auth/store.js';
import { Disclosure } from '../components/Disclosure.js';
import { Turnstile, turnstileEnabled, type TurnstileHandle } from '../components/Turnstile.js';

type Step =
  | { tag: 'form'; error?: string }
  | { tag: 'busy' }
  | { tag: 'totp'; username: string; password: string; code: string; error: string | undefined; submitting: boolean };

function loginErrorMsg(code: Extract<LoginResult, { ok: false }>['code']): string {
  switch (code) {
    case 'invalid': return 'Incorrect username or password';
    case 'totp_invalid': return 'Incorrect authentication code';
    case 'rate_limited': return 'Too many attempts — please wait a moment';
    case 'network': return 'Connection error — please try again';
    case 'challenge': return 'Please complete the challenge below and try again';
    default: return 'Something went wrong — please try again';
  }
}

/**
 * Should this outcome turn the anti-abuse challenge on for the rest of the flow? Failure-triggered
 * Turnstile: flip on the server's explicit challenge signal, OR on an outcome that records a throttle
 * failure server-side (`invalid` / `totp_invalid`) — so the NEXT submit already carries a token instead of
 * burning a round-trip to learn one is now required. `totp_required` records NO failure → must NOT flip.
 */
function loginFlipsChallenge(code: Extract<LoginResult, { ok: false }>['code']): boolean {
  return code === 'challenge' || code === 'invalid' || code === 'totp_invalid';
}

export function LoginRoute() {
  const { beginAuth, finalizeAuth, login } = useAuthStore();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>({ tag: 'form' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Turnstile token (null until solved). When the widget is disabled (no sitekey) it stays null and
  // never gates submit — the server gate is inert too, so the pair degrades cleanly.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle | null>(null);
  // Failure-triggered challenge: the widget is hidden and submit ungated on a clean first attempt; this
  // flips true (and stays true for the rest of the flow) once the server demands the challenge or an
  // attempt records a throttle failure. Once true, submit gates on turnstileEnabled && !token (old behavior).
  const [challengeNeeded, setChallengeNeeded] = useState(false);
  const gateOnChallenge = challengeNeeded && turnstileEnabled && !turnstileToken;

  const handleLogin = () => {
    beginAuth();
    setStep({ tag: 'busy' });
    login(username.trim(), password, undefined, turnstileToken ?? undefined).then(async (result) => {
      // A spent Turnstile token is single-use — re-challenge on any non-entry outcome so a retry
      // (wrong password, totp prompt) carries a fresh token rather than replaying the consumed one.
      if (!(result.ok && !result.recoveryRequired)) turnstileRef.current?.reset();
      if (!result.ok && loginFlipsChallenge(result.code)) setChallengeNeeded(true);
      if (result.ok) {
        if (result.recoveryRequired) {
          // Forced-phrase belt: account has no finalized phrase — route there before entry.
          // isAuthing=true keeps the gate pinned; finalizeAuth happens at save+ack in ForcedPhraseRoute.
          navigate('/forced-phrase', { replace: true });
        } else {
          const r = await finalizeAuth();
          if (r.ok) {
            navigate('/', { replace: true });
          } else {
            setStep({ tag: 'form', error: 'Connection error — please try again' });
          }
        }
      } else if (result.code === 'totp_required') {
        setStep({ tag: 'totp', username: username.trim(), password, code: '', error: undefined, submitting: false });
      } else {
        setStep({ tag: 'form', error: loginErrorMsg(result.code) });
      }
    }).catch(() => setStep({ tag: 'form', error: 'Connection error — please try again' }));
  };

  const handleTotpSubmit = () => {
    if (step.tag !== 'totp') return;
    setStep({ ...step, submitting: true, error: undefined });
    // The server gate runs on EVERY /login call (incl. this second, code-carrying one), so this re-call
    // needs its own fresh Turnstile token — the totp screen re-renders the widget for that.
    login(step.username, step.password, step.code, turnstileToken ?? undefined).then(async (result) => {
      if (!result.ok) turnstileRef.current?.reset();
      if (!result.ok && loginFlipsChallenge(result.code)) setChallengeNeeded(true);
      if (!step || step.tag !== 'totp') return;
      if (result.ok) {
        if (result.recoveryRequired) {
          navigate('/forced-phrase', { replace: true });
        } else {
          const r = await finalizeAuth();
          if (r.ok) {
            navigate('/', { replace: true });
          } else {
            setStep({ ...step, submitting: false, error: 'Connection error — please try again' });
          }
        }
      } else {
        setStep({ ...step, submitting: false, error: loginErrorMsg(result.code) });
      }
    }).catch(() => {
      if (step.tag !== 'totp') return;
      setStep({ ...step, submitting: false, error: 'Connection error — please try again' });
    });
  };

  if (step.tag === 'busy') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }

  if (step.tag === 'totp') {
    return (
      <div className="auth">
        <h1 className="auth__title">Enter your authentication code</h1>
        <p className="auth__subtitle">
          Open your authenticator app and enter the 6-digit code.
        </p>
        <input
          className="auth__input auth__totp-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={step.code}
          onChange={(e) => { if (step.tag !== 'totp') return; setStep({ ...step, code: e.target.value.replace(/\D/g, '') }); }}
          aria-label="6-digit authentication code"
          disabled={step.submitting}
          autoFocus
        />
        {step.error && <p className="auth__error">{step.error}</p>}
        {/* Re-render the widget for the code-carrying re-call ONLY when the challenge is already on (a
            totp_required-only first factor never trips it). */}
        {challengeNeeded && <Turnstile ref={turnstileRef} onToken={setTurnstileToken} />}
        <button
          className="auth__btn auth__btn--primary"
          onClick={handleTotpSubmit}
          disabled={step.code.length < 6 || step.submitting || gateOnChallenge}
        >
          {step.submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button className="auth__link" onClick={() => setStep({ tag: 'form' })}>
          Back
        </button>
      </div>
    );
  }

  // form step
  const formError = step.tag === 'form' ? step.error : undefined;
  return (
    <div className="auth">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Sign in to deltos</h1>

      <input
        className="auth__input"
        type="text"
        value={username}
        onChange={(e) => { setUsername(e.target.value); if (step.tag === 'form' && step.error) setStep({ tag: 'form' }); }}
        placeholder="Username"
        autoCapitalize="none"
        autoComplete="username"
        aria-label="Username"
      />
      <input
        className="auth__input"
        type="password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); if (step.tag === 'form' && step.error) setStep({ tag: 'form' }); }}
        placeholder="Password"
        autoComplete="current-password"
        aria-label="Password"
        onKeyDown={(e) => { if (e.key === 'Enter' && username.trim() && password && !gateOnChallenge) handleLogin(); }}
      />

      {formError && <p className="auth__error">{formError}</p>}

      {challengeNeeded && <Turnstile ref={turnstileRef} onToken={setTurnstileToken} />}

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleLogin}
        disabled={!username.trim() || !password || gateOnChallenge}
      >
        Sign in
      </button>

      <div className="auth__links">
        <Link to="/reset" className="auth__link">Forgot your password?</Link>
        <Link to="/register" className="auth__link">Create an account</Link>
      </div>
      {/* Copy A reaffirm — secSys placement requirement @2cd2958 */}
      <Disclosure />
    </div>
  );
}
