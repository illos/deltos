/**
 * QrReceiveRoute — receive side of the QR-join protocol (PIN-ID-7).
 *
 * The sender displays a QR code encoding the mnemonic (via encodeQrPayload). The receiver:
 *   1. Scans the QR (or copies the payload string) and pastes the mnemonic here.
 *   2. This screen generates and displays a 6-digit confirmation code.
 *   3. The receiver reads the code aloud to the sender; the sender verifies it verbally.
 *   4. The receiver taps "Code confirmed" — only THEN does WebAuthn create() fire.
 *
 * Security: the confirmation code (random, generated before WebAuthn) prevents a
 * silently-intercepted QR from being used without the sender's in-person acknowledgement.
 *
 * PIN-ID-9: the "Code confirmed" button calls enrollExisting() synchronously so that
 * WebAuthn create() is the first await inside the gesture's activation window.
 */
import { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore, detectDeviceLabel } from '../auth/store.js';
import { decodeQrPayload, generateConfirmationCode } from '../identity/qrJoin.js';
import { Disclosure } from '../components/Disclosure.js';

type Step =
  | { tag: 'entry' }
  | { tag: 'confirm'; mnemonic: string; code: string }
  | { tag: 'busy'; msg: string }
  | { tag: 'disclosure'; usesPrf: boolean }
  | { tag: 'error'; msg: string };

export function QrReceiveRoute() {
  const { enrollExisting, register, mintSession } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ tag: 'entry' });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleNext = () => {
    const raw = inputRef.current?.value.trim() ?? '';
    // Accept either a raw mnemonic or a full QR payload string (deltos:join:...).
    const mnemonic = decodeQrPayload(raw) ?? raw;
    if (!mnemonic) return;
    // Generate the out-of-band confirmation code BEFORE WebAuthn (not part of crypto — pure UX).
    const code = generateConfirmationCode();
    setStep({ tag: 'confirm', mnemonic, code });
  };

  // PIN-ID-9: synchronous handler — no preceding await before enrollExisting() call.
  const handleConfirmed = () => {
    if (step.tag !== 'confirm') return;
    const { mnemonic } = step;
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

  if (step.tag === 'confirm') {
    return (
      <div className="auth">
        <h1 className="auth__title">Confirm with the other device</h1>
        <p className="auth__subtitle">
          Read this code aloud to the person holding the other device.
          They should confirm they see your code before you continue.
        </p>

        <div className="auth__confirm-code" aria-label="Confirmation code">
          {step.code}
        </div>

        <p className="auth__hint">
          Once the other device confirms your code verbally, tap the button below.
        </p>

        <button className="auth__btn auth__btn--primary" onClick={handleConfirmed}>
          Code confirmed — continue
        </button>
        <button className="auth__link" onClick={() => setStep({ tag: 'entry' })}>
          Start over
        </button>
      </div>
    );
  }

  if (step.tag === 'disclosure') {
    return (
      <div className="auth">
        <h1 className="auth__title">Joined successfully</h1>
        <p className="auth__subtitle">
          Your identity has been bound to a new passkey on this device.
        </p>

        {/* Device-local disclosure — REQUIRED at join-confirmation (secSys HARD #2: QR-join/device-add
            is a credential-establishment path; mounted UNCONDITIONALLY, never gated. Under Option-A
            usesPrf is always false → device-local copy). gruntSys2 owns the copy. */}
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
        <h1 className="auth__title">Join failed</h1>
        <p className="auth__error">{step.msg}</p>
        <button className="auth__btn" onClick={() => setStep({ tag: 'entry' })}>Try again</button>
        <div className="auth__links">
          <Link to="/recover" className="auth__link">Recover manually instead</Link>
        </div>
      </div>
    );
  }

  // entry step
  return (
    <div className="auth">
      <h1 className="auth__title">Join via QR code</h1>
      <p className="auth__subtitle">
        Ask the owner of this account to show a QR code on their device.
        Scan it with your camera app, then paste the recovery phrase below.
        Or paste a QR payload string directly (starts with <code>deltos:join:</code>).
      </p>

      <textarea
        ref={inputRef}
        className="auth__input"
        placeholder="Paste the recovery phrase or QR payload here…"
        rows={4}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />

      <button className="auth__btn auth__btn--primary" onClick={handleNext}>
        Next
      </button>

      <div className="auth__links">
        <Link to="/recover" className="auth__link">Recover with phrase instead</Link>
        <Link to="/enroll" className="auth__link">Back to setup</Link>
      </div>
    </div>
  );
}
