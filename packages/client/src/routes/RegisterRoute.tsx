/**
 * RegisterRoute — create account (username + password) → show recovery phrase → optional 2FA.
 *
 * P0 LATCH: beginAuth() at ceremony start; finalizeAuth() ONLY after the phrase is acknowledged
 * and any TOTP setup is confirmed. The shell gate stays pinned to this route until finalizeAuth —
 * never open the shell at an intermediate step (the P0 enroll-unmount class).
 *
 * TOTP anti-lockout (secSys): setupTotp() returns the QR URI; 2FA is ONLY enabled after the user
 * successfully confirms a code via verifyTotp() — never on QR scan alone.
 *
 * Copy A (at-rest disclosure) on the form step; copy B (phrase = master key) inline at the phrase
 * step; copy D (anti-lockout reassurance) at the TOTP-setup step. planSys @2cd2958.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore } from '../auth/store.js';
import type { RegisterResult, TotpSetupResult, TotpVerifyResult } from '../auth/store.js';
import { Disclosure } from '../components/Disclosure.js';

type Step =
  | { tag: 'form'; error?: string }
  | { tag: 'busy'; msg: string }
  | { tag: 'phrase'; recoveryPhrase: string }
  | { tag: 'totp-prompt' }
  | { tag: 'totp-setup'; uri: string; code: string; codeError: string | undefined; submitting: boolean };

function registerErrorMsg(code: Extract<RegisterResult, { ok: false }>['code']): string {
  switch (code) {
    case 'username_taken': return 'That username is already in use';
    case 'weak_password': return 'Password must be at least 8 characters';
    case 'rate_limited': return 'Too many attempts — please wait a moment';
    case 'network': return 'Connection error — please try again';
    default: return 'Something went wrong — please try again';
  }
}

export function RegisterRoute() {
  const { beginAuth, finalizeAuth, register, setupTotp, verifyTotp } = useAuthStore();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>({ tag: 'form' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phraseSaved, setPhraseSaved] = useState(false);
  const [phraseCopied, setPhraseCopied] = useState(false);

  const handleRegister = () => {
    if (password !== confirm) { setStep({ tag: 'form', error: "Passwords don't match" }); return; }
    if (password.length < 8) { setStep({ tag: 'form', error: 'Password must be at least 8 characters' }); return; }
    beginAuth(); // P0 latch — pins the gate to this route until finalizeAuth
    setStep({ tag: 'busy', msg: 'Creating your account…' });
    register(username.trim(), password).then((result) => {
      if (result.ok) {
        setStep({ tag: 'phrase', recoveryPhrase: result.recoveryPhrase });
      } else {
        setStep({ tag: 'form', error: registerErrorMsg(result.code) });
      }
    }).catch(() => setStep({ tag: 'form', error: 'Connection error — please try again' }));
  };

  const handleSetUpTotp = () => {
    setStep({ tag: 'busy', msg: 'Setting up 2-factor authentication…' });
    setupTotp().then((result: TotpSetupResult) => {
      if (result.ok) {
        setStep({ tag: 'totp-setup', uri: result.uri, code: '', codeError: undefined, submitting: false });
      } else {
        setStep({ tag: 'totp-prompt' }); // failed — let user skip
      }
    }).catch(() => setStep({ tag: 'totp-prompt' }));
  };

  const handleSkipTotp = () => {
    finalizeAuth(); // ceremony complete — open the shell
    navigate('/', { replace: true });
  };

  const handleVerifyTotp = () => {
    if (step.tag !== 'totp-setup') return;
    setStep({ ...step, submitting: true, codeError: undefined });
    verifyTotp(step.code).then((result: TotpVerifyResult) => {
      if (result.ok) {
        finalizeAuth(); // TOTP confirmed and enabled — ceremony complete
        navigate('/', { replace: true });
      } else {
        if (step.tag !== 'totp-setup') return;
        setStep({ ...step, submitting: false, codeError: 'Incorrect code — please try again' });
      }
    }).catch(() => {
      if (step.tag !== 'totp-setup') return;
      setStep({ ...step, submitting: false, codeError: 'Connection error — please try again' });
    });
  };

  if (step.tag === 'busy') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
        <p className="auth__subtitle">{step.msg}</p>
      </div>
    );
  }

  if (step.tag === 'phrase') {
    const words = step.recoveryPhrase.split(' ');
    return (
      <div className="auth">
        <h1 className="auth__title">Save your recovery phrase</h1>
        {/* Copy B — planSys @2cd2958: phrase = master key, one-way derivation */}
        <p className="auth__subtitle">
          This phrase is the <strong>master key to your account</strong>. If you ever forget
          your password, it's the only way back in — and it can reset your password and turn
          off two-factor authentication, so it's as powerful as full access to your account.
          We can't recover it for you, and we'll never show it again. Write it down and keep
          it somewhere safe.
        </p>

        <div className="auth__phrase" aria-label="Recovery phrase">
          {words.map((word, i) => (
            <span key={i} className="auth__phrase-word">
              <span className="auth__phrase-num">{i + 1}</span>
              {word}
            </span>
          ))}
        </div>

        <button
          className="auth__btn"
          onClick={() => {
            void navigator.clipboard.writeText(step.recoveryPhrase).then(() => {
              setPhraseCopied(true);
              setTimeout(() => setPhraseCopied(false), 2000);
            });
          }}
        >
          {phraseCopied ? 'Copied!' : 'Copy phrase'}
        </button>

        {/* Required ack — copy B planSys @2cd2958 */}
        <label className="auth__checkbox-label">
          <input
            type="checkbox"
            checked={phraseSaved}
            onChange={(e) => setPhraseSaved(e.target.checked)}
          />
          I've saved my recovery phrase somewhere safe.
        </label>

        <button
          className="auth__btn auth__btn--primary"
          onClick={() => setStep({ tag: 'totp-prompt' })}
          disabled={!phraseSaved}
        >
          Continue
        </button>
      </div>
    );
  }

  if (step.tag === 'totp-prompt') {
    return (
      <div className="auth">
        <h1 className="auth__title">Add 2-factor authentication?</h1>
        <p className="auth__subtitle">
          An authenticator app generates a one-time code required at login —
          in addition to your password. You can set this up later from account settings.
        </p>
        <button className="auth__btn auth__btn--primary" onClick={handleSetUpTotp}>
          Set up 2FA
        </button>
        <button className="auth__link" onClick={handleSkipTotp}>
          Skip for now
        </button>
      </div>
    );
  }

  if (step.tag === 'totp-setup') {
    return (
      <div className="auth">
        <h1 className="auth__title">Scan the QR code</h1>
        <p className="auth__subtitle">
          Open your authenticator app and scan this code, then enter the
          6-digit code it shows to confirm and enable 2FA.
        </p>
        {/* Copy D — planSys @2cd2958: anti-lockout reassurance */}
        <p className="auth__hint">
          If you ever lose your authenticator, your recovery phrase can turn off two-factor
          and get you back in.
        </p>
        <div className="auth__qr">
          <QRCodeSVG value={step.uri} size={200} bgColor="transparent" fgColor="currentColor" />
        </div>
        <input
          className="auth__input auth__totp-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={step.code}
          onChange={(e) => { if (step.tag !== 'totp-setup') return; setStep({ ...step, code: e.target.value.replace(/\D/g, '') }); }}
          aria-label="6-digit verification code"
          disabled={step.submitting}
        />
        {step.codeError && <p className="auth__error">{step.codeError}</p>}
        <button
          className="auth__btn auth__btn--primary"
          onClick={handleVerifyTotp}
          disabled={step.code.length < 6 || step.submitting}
        >
          {step.submitting ? 'Verifying…' : 'Verify and enable 2FA'}
        </button>
        <button className="auth__link" onClick={handleSkipTotp}>
          Skip 2FA for now
        </button>
      </div>
    );
  }

  // form step (default)
  const formError = step.tag === 'form' ? step.error : undefined;
  return (
    <div className="auth">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Create your account</h1>
      <p className="auth__subtitle">
        Your notes sync across devices and stay accessible offline.
      </p>
      {/* Copy A — at-rest residual-risk disclosure (secSys establishment gate) */}
      <Disclosure />

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
        placeholder="Password (8+ characters)"
        autoComplete="new-password"
        aria-label="Password (8+ characters)"
      />
      <input
        className="auth__input"
        type="password"
        value={confirm}
        onChange={(e) => { setConfirm(e.target.value); if (step.tag === 'form' && step.error) setStep({ tag: 'form' }); }}
        placeholder="Confirm password"
        autoComplete="new-password"
        aria-label="Confirm password"
      />

      {formError && <p className="auth__error">{formError}</p>}

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleRegister}
        disabled={!username.trim() || !password || !confirm}
      >
        Create account
      </button>

      <Link to="/login" className="auth__link">Already have an account? Sign in</Link>
    </div>
  );
}
