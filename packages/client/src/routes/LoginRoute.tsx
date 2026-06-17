/**
 * LoginRoute — username + password (+ optional TOTP) authentication.
 *
 * P0 LATCH: beginAuth() at ceremony start; finalizeAuth() only on ok. The latch pins the gate
 * to this route — the shell never opens at an intermediate step.
 *
 * Uniform error on invalid credentials (no username enumeration). totp_required triggers the
 * inline TOTP field; the route re-calls login(username, password, code) with the code.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import type { LoginResult } from '../auth/store.js';

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
    default: return 'Something went wrong — please try again';
  }
}

export function LoginRoute() {
  const { beginAuth, finalizeAuth, login } = useAuthStore();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>({ tag: 'form' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = () => {
    beginAuth();
    setStep({ tag: 'busy' });
    login(username.trim(), password).then((result) => {
      if (result.ok) {
        finalizeAuth();
        navigate('/', { replace: true });
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
    login(step.username, step.password, step.code).then((result) => {
      if (!step || step.tag !== 'totp') return;
      if (result.ok) {
        finalizeAuth();
        navigate('/', { replace: true });
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
        <button
          className="auth__btn auth__btn--primary"
          onClick={handleTotpSubmit}
          disabled={step.code.length < 6 || step.submitting}
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
        onKeyDown={(e) => { if (e.key === 'Enter' && username.trim() && password) handleLogin(); }}
      />

      {formError && <p className="auth__error">{formError}</p>}

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleLogin}
        disabled={!username.trim() || !password}
      >
        Sign in
      </button>

      <div className="auth__links">
        <Link to="/reset" className="auth__link">Forgot your password?</Link>
        <Link to="/register" className="auth__link">Create an account</Link>
      </div>
    </div>
  );
}
