/**
 * UnlockRoute — returning user passkey unlock.
 *
 * Flow: idle → [button click] → unlocking (WebAuthn get) → minting session → navigate to /
 *
 * E4 belt: if keyId is absent from localStorage (iOS evicts localStorage more aggressively
 * than IndexedDB), init() recovers it from IDB. As a true fallback, if keyId is still null
 * after unlock, we re-register the same signing key — the server resolves the account by
 * public-key fingerprint and returns a fresh keyId tied to the same accountId (devSys validated).
 * This avoids the "not registered" dead-end without persisting the bearer token (F7 upheld).
 *
 * No security disclosure here — the pilot ruling is: disclosure only at credential-establishment
 * (enroll / recovery / QR-join), never on the day-to-day launch/unlock path.
 *
 * PIN-ID-9: the "Unlock" button calls unlock() synchronously (no preceding await) so that
 * WebAuthn get() is the first await within the gesture's transient activation window.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore, detectDeviceLabel } from '../auth/store.js';

type Step = 'idle' | 'unlocking' | 'minting' | 'error';

export function UnlockRoute() {
  const { unlock, mintSession, register, keyId } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // PIN-ID-9: synchronous handler — no preceding await before unlock() call.
  const handleUnlock = () => {
    setStep('unlocking');
    unlock()
      .then(async (result) => {
        if (result === 'cancelled') {
          setStep('idle');
          return;
        }
        setStep('minting');
        // E4 belt: keyId may be null if iOS evicted localStorage and init()'s IDB recovery
        // also came up empty (device was enrolled but never registered, or IDB was cleared).
        // Re-register the same signing key — server reuses the account → fresh keyId.
        if (!keyId) {
          await register(detectDeviceLabel());
        }
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

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleUnlock}
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
