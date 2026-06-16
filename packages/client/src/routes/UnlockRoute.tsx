/**
 * UnlockRoute — returning user passkey unlock.
 *
 * Flow: idle → [button click] → unlocking (WebAuthn get) → minting session → navigate to /
 *
 * D5 disclosure: shown when the stored enrollment used the no-PRF device-key fallback.
 * Displayed as a persistent notice (not a gate) — the user unlocked legitimately.
 *
 * PIN-ID-9: the "Unlock" button calls unlock() synchronously (no preceding await) so that
 * WebAuthn get() is the first await within the gesture's transient activation window.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import { Disclosure } from '../components/Disclosure.js';

type Step = 'idle' | 'unlocking' | 'minting' | 'error';

export function UnlockRoute() {
  const { unlock, mintSession, usesPrf, keyId } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // PIN-ID-9: synchronous handler — no preceding await before unlock() call.
  const handleUnlock = () => {
    setStep('unlocking');
    unlock()
      .then((result) => {
        if (result === 'cancelled') {
          setStep('idle');
          return;
        }
        setStep('minting');
        return mintSession();
      })
      .then(() => {
        navigate('/', { replace: true });
      })
      .catch((e: Error) => {
        setErrorMsg(e.message);
        setStep('error');
      });
  };

  if (step === 'unlocking' || step === 'minting') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
        <p className="auth__subtitle">
          {step === 'unlocking' ? 'Verifying your passkey…' : 'Starting session…'}
        </p>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="auth">
        <h1 className="auth__title">Unlock failed</h1>
        <p className="auth__error">{errorMsg}</p>
        <button className="auth__btn" onClick={() => setStep('idle')}>Try again</button>
        <div className="auth__links">
          <Link to="/recover" className="auth__link">Recover with phrase</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Welcome back</h1>
      <p className="auth__subtitle">Use your passkey to unlock deltos.</p>

      {/* D5 disclosure on the unlock screen too — user should see it on every unlock if no PRF */}
      {usesPrf === false && <Disclosure />}

      {!keyId && (
        <p className="auth__error">
          This device hasn't been registered with the server yet.
          Use your recovery phrase to re-register.
        </p>
      )}

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleUnlock}
        disabled={!keyId}
      >
        Unlock with Passkey
      </button>

      <div className="auth__links">
        <Link to="/recover" className="auth__link">Recover with phrase</Link>
        <Link to="/qr-receive" className="auth__link">Join this device via QR</Link>
      </div>
    </div>
  );
}
