/**
 * RecoverRoute — re-bind an existing identity to this device using a mnemonic phrase.
 *
 * Flow:
 *   entry → [submit mnemonic] → recovering (WebAuthn create) → D5 disclosure if needed
 *        → [confirmed] → registering → session → navigate to /
 *
 * The submitted mnemonic re-derives the SAME identity hierarchy as the original device,
 * so the accountFingerprint sent to the server matches the existing account. The server
 * mints a NEW device entry (new keyId) for this passkey — the old device is not revoked.
 *
 * PIN-ID-9: the "Recover" button calls enrollExisting() synchronously (no preceding await)
 * so that WebAuthn create() is the first await inside the gesture activation window.
 */
import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore, detectDeviceLabel } from '../auth/store.js';
import { Disclosure } from '../components/Disclosure.js';

type Step =
  | { tag: 'entry' }
  | { tag: 'busy'; msg: string }
  | { tag: 'disclosure'; usesPrf: boolean }
  | { tag: 'error'; msg: string };

export function RecoverRoute() {
  const { enrollExisting, register, mintSession } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ tag: 'entry' });
  const mnemonicRef = useRef<HTMLTextAreaElement>(null);

  // PIN-ID-9: synchronous handler — no preceding await before enrollExisting() call.
  const handleRecover = () => {
    const mnemonic = mnemonicRef.current?.value.trim() ?? '';
    if (!mnemonic) return;
    setStep({ tag: 'busy', msg: 'Creating your passkey…' });
    enrollExisting(mnemonic)
      .then(({ usesPrf }) => {
        setStep({ tag: 'disclosure', usesPrf });
      })
      .catch((e: Error) => {
        setStep({ tag: 'error', msg: e.message });
      });
  };

  const handleFinish = () => {
    setStep({ tag: 'busy', msg: 'Registering this device…' });
    const deviceLabel = detectDeviceLabel();
    register(deviceLabel)
      .then(() => {
        setStep({ tag: 'busy', msg: 'Starting session…' });
        return mintSession();
      })
      .then(() => {
        navigate('/', { replace: true });
      })
      .catch((e: Error) => {
        setStep({ tag: 'error', msg: e.message });
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

  if (step.tag === 'disclosure') {
    return (
      <div className="auth">
        <h1 className="auth__title">Recovery successful</h1>
        <p className="auth__subtitle">
          Your identity has been re-bound to a new passkey on this device.
        </p>

        {/* Device-local disclosure — mounted UNCONDITIONALLY at this establishment path (secSys
            built-code gate: every credential-establishment path shows it; under Option-A usesPrf is
            always false → device-local copy). gruntSys2 owns the copy. */}
        <Disclosure prf={step.usesPrf} />

        <button className="auth__btn auth__btn--primary" onClick={handleFinish}>
          Continue to deltos
        </button>
      </div>
    );
  }

  if (step.tag === 'error') {
    return (
      <div className="auth">
        <h1 className="auth__title">Recovery failed</h1>
        <p className="auth__error">{step.msg}</p>
        <button className="auth__btn" onClick={() => setStep({ tag: 'entry' })}>Try again</button>
        <div className="auth__links">
          <Link to="/enroll" className="auth__link">Back to setup</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1 className="auth__title">Recover your account</h1>
      <p className="auth__subtitle">
        Enter your 24-word recovery phrase. A new passkey will be created on this device,
        and your account will be re-linked.
      </p>

      <textarea
        ref={mnemonicRef}
        className="auth__input"
        placeholder="word1 word2 word3 … (24 words, space-separated)"
        rows={4}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />

      <button className="auth__btn auth__btn--primary" onClick={handleRecover}>
        Recover with Passkey
      </button>

      <div className="auth__links">
        <Link to="/enroll" className="auth__link">Back to setup</Link>
        <Link to="/qr-receive" className="auth__link">Join via QR instead</Link>
      </div>
    </div>
  );
}
