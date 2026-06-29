/**
 * ResetRoute — reset password using the 24-word recovery phrase.
 *
 * P0 LATCH: beginAuth() at ceremony start; finalizeAuth() on success. Uniform non-disclosing
 * error — wrong username/phrase returns the same message (no confirmation of whether the
 * username exists). On success the server revokes all sessions and signs in with the new password.
 */
import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import type { ResetResult } from '../auth/store.js';
import { Turnstile, turnstileEnabled, type TurnstileHandle } from '../components/Turnstile.js';

type Step =
  | { tag: 'form'; error?: string }
  | { tag: 'busy' }
  | { tag: 'done' };

function resetErrorMsg(code: Extract<ResetResult, { ok: false }>['code']): string {
  switch (code) {
    case 'rate_limited': return 'Too many attempts — please wait a moment';
    case 'network': return 'Connection error — please try again';
    default: return 'Incorrect details — please check your recovery phrase';
  }
}

export function ResetRoute() {
  const { beginAuth, finalizeAuth, resetWithPhrase } = useAuthStore();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>({ tag: 'form' });
  const [username, setUsername] = useState('');
  const [phrase, setPhrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Turnstile token for the gated /reset call (null until solved; inert when no sitekey is configured).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle | null>(null);

  const handleReset = () => {
    if (newPassword !== confirm) { setStep({ tag: 'form', error: "Passwords don't match" }); return; }
    if (newPassword.length < 8) { setStep({ tag: 'form', error: 'Password must be at least 8 characters' }); return; }
    beginAuth();
    setStep({ tag: 'busy' });
    resetWithPhrase(username.trim(), phrase.trim(), newPassword, turnstileToken ?? undefined).then(async (result) => {
      if (!result.ok) turnstileRef.current?.reset(); // spent token — re-challenge for the retry
      if (result.ok) {
        // Password is changed. Try to finalize a session — but /reset mints no session cookie
        // by design, so /finalize may 503. Treat any finalize failure as graceful degradation:
        // show success and route to /login rather than surfacing a false 'connection error'.
        try {
          const r = await finalizeAuth();
          if (r.ok) {
            navigate('/', { replace: true });
            return;
          }
        } catch { /* finalize threw — fall through to done */ }
        setStep({ tag: 'done' });
      } else {
        setStep({ tag: 'form', error: resetErrorMsg(result.code) });
      }
    }).catch(() => setStep({ tag: 'form', error: 'Connection error — please try again' }));
  };

  if (step.tag === 'busy') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
        <p className="auth__subtitle">Resetting your password…</p>
      </div>
    );
  }

  if (step.tag === 'done') {
    return (
      <div className="auth">
        <h1 className="auth__title">Password reset</h1>
        <p className="auth__subtitle">Your password has been updated. Sign in to continue.</p>
        <p className="auth__hint">Two-factor authentication has been turned off. You can re-enable it in Settings.</p>
        <button
          className="auth__btn auth__btn--primary"
          onClick={() => navigate('/login', { replace: true })}
        >
          Sign in
        </button>
      </div>
    );
  }

  const formError = step.tag === 'form' ? step.error : undefined;
  const clearError = () => { if (step.tag === 'form' && step.error) setStep({ tag: 'form' }); };

  return (
    <div className="auth">
      <h1 className="auth__title">Reset your password</h1>
      <p className="auth__subtitle">
        Enter your username, your 24-word recovery phrase, and choose a new password.
      </p>

      <input
        className="auth__input"
        type="text"
        value={username}
        onChange={(e) => { setUsername(e.target.value); clearError(); }}
        placeholder="Username"
        autoCapitalize="none"
        autoComplete="username"
        aria-label="Username"
      />

      <textarea
        className="auth__input auth__phrase-input"
        value={phrase}
        onChange={(e) => { setPhrase(e.target.value); clearError(); }}
        placeholder="Enter your 24-word recovery phrase…"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label="Recovery phrase"
        rows={3}
      />

      <input
        className="auth__input"
        type="password"
        value={newPassword}
        onChange={(e) => { setNewPassword(e.target.value); clearError(); }}
        placeholder="New password (8+ characters)"
        autoComplete="new-password"
        aria-label="New password"
      />
      <input
        className="auth__input"
        type="password"
        value={confirm}
        onChange={(e) => { setConfirm(e.target.value); clearError(); }}
        placeholder="Confirm new password"
        autoComplete="new-password"
        aria-label="Confirm new password"
      />

      {formError && <p className="auth__error">{formError}</p>}

      {/* Copy C — planSys @2cd2958 / #56: 2FA-clear is the primary callout (disableTotp runs before revokeAll by design) */}
      <p className="auth__hint">
        Resetting your password will also turn off two-factor authentication — you can turn it
        back on in Settings afterward. This will also sign you out on every device.
      </p>

      <Turnstile ref={turnstileRef} onToken={setTurnstileToken} />

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleReset}
        disabled={!username.trim() || !phrase.trim() || !newPassword || !confirm || (turnstileEnabled && !turnstileToken)}
      >
        Reset password
      </button>

      <Link to="/login" className="auth__link">Back to sign in</Link>
    </div>
  );
}
