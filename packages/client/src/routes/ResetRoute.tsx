/**
 * ResetRoute — reset password using the 24-word recovery phrase.
 *
 * P0 LATCH: beginAuth() at ceremony start; finalizeAuth() on success. Uniform non-disclosing
 * error — wrong username/phrase returns the same message (no confirmation of whether the
 * username exists). On success the server revokes all sessions and signs in with the new password.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import type { ResetResult } from '../auth/store.js';

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

  const handleReset = () => {
    if (newPassword !== confirm) { setStep({ tag: 'form', error: "Passwords don't match" }); return; }
    if (newPassword.length < 8) { setStep({ tag: 'form', error: 'Password must be at least 8 characters' }); return; }
    beginAuth();
    setStep({ tag: 'busy' });
    resetWithPhrase(username.trim(), phrase.trim(), newPassword).then(async (result) => {
      if (result.ok) {
        const r = await finalizeAuth();
        if (r.ok) {
          navigate('/', { replace: true });
        } else {
          setStep({ tag: 'form', error: 'Connection error — please try again' });
        }
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

      {/* Copy C — planSys @2cd2958: honest revoke-all + 2FA-clear consequence */}
      <p className="auth__hint">
        Resetting with your recovery phrase sets a new password, turns off two-factor (you
        can set it up again afterward), and signs you out on every device.
      </p>

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleReset}
        disabled={!username.trim() || !phrase.trim() || !newPassword || !confirm}
      >
        Reset password
      </button>

      <Link to="/login" className="auth__link">Back to sign in</Link>
    </div>
  );
}
