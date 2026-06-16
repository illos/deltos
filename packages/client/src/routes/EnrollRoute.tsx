/**
 * EnrollRoute — first-time device setup and mnemonic display.
 *
 * Flow:
 *   welcome → [button click] → enrolling → mnemonic-display → [save confirmed] → registering → done
 *
 * D5 disclosure: when the new enrolment uses the no-PRF device-key fallback (usesPrf === false),
 * the mnemonic-display step shows the Disclosure banner before the "I've saved it" confirmation.
 * This is the MANDATORY render for secSys's PIN-ID-6 clearance condition.
 *
 * PIN-ID-9: the "Set up" button calls enroll() synchronously (no preceding awaits) so that
 * WebAuthn create() is the first await within the gesture's transient activation window.
 *
 * QR-send: the mnemonic display step also shows the QR payload for the QR-join protocol.
 * The mnemonic is ONLY available during this step (custody boundary — enrollNew returns it
 * once; it is never exposed again).
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore, detectDeviceLabel } from '../auth/store.js';
import { encodeQrPayload } from '../identity/qrJoin.js';
import { Disclosure } from '../components/Disclosure.js';

type Step =
  | { tag: 'welcome' }
  | { tag: 'busy'; msg: string }
  | { tag: 'mnemonic'; mnemonic: string; usesPrf: boolean }
  | { tag: 'error'; msg: string };

export function EnrollRoute() {
  const { enroll, register, mintSession } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ tag: 'welcome' });
  const [phraseSaved, setPhraseSaved] = useState(false);
  const [showQr, setShowQr] = useState(false);

  // PIN-ID-9: synchronous handler — no preceding await before enroll() call.
  const handleSetUp = () => {
    setStep({ tag: 'busy', msg: 'Creating your passkey…' });
    enroll()
      .then(({ mnemonic, usesPrf }) => {
        setStep({ tag: 'mnemonic', mnemonic, usesPrf });
      })
      .catch((e: Error) => {
        setStep({ tag: 'error', msg: e.message });
      });
  };

  const handleContinue = () => {
    if (step.tag !== 'mnemonic') return;
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

  if (step.tag === 'error') {
    return (
      <div className="auth">
        <h1 className="auth__title">Something went wrong</h1>
        <p className="auth__error">{step.msg}</p>
        <button className="auth__btn" onClick={() => setStep({ tag: 'welcome' })}>
          Try again
        </button>
      </div>
    );
  }

  if (step.tag === 'mnemonic') {
    const words = step.mnemonic.split(' ');
    return (
      <div className="auth">
        <h1 className="auth__title">Save your recovery phrase</h1>
        <p className="auth__subtitle">
          These 24 words are the only way to recover your account on a new device.
          Write them down in order and keep them safe — deltos cannot recover them for you.
        </p>

        {/* D5 disclosure — MANDATORY when PRF is unavailable (secSys PIN-ID-6 acceptance condition) */}
        {!step.usesPrf && <Disclosure />}

        <div className="auth__phrase" aria-label="Recovery phrase">
          {words.map((word, i) => (
            <span key={i} className="auth__phrase-word">
              <span className="auth__phrase-num">{i + 1}</span>
              {word}
            </span>
          ))}
        </div>

        {/* QR-send: encoded mnemonic for another device to scan (in-person QR-join) */}
        <button
          className="auth__link"
          onClick={() => setShowQr(v => !v)}
          aria-expanded={showQr}
        >
          {showQr ? 'Hide QR code' : 'Add another device via QR code'}
        </button>
        {showQr && (
          <div className="auth__qr">
            <QRCodeSVG
              value={encodeQrPayload(step.mnemonic)}
              size={200}
              bgColor="transparent"
              fgColor="currentColor"
            />
            <p className="auth__qr-hint">
              Scan on the other device, note the confirmation code shown there,
              then verify it verbally before confirming on that device.
            </p>
          </div>
        )}

        <label className="auth__checkbox-label">
          <input
            type="checkbox"
            checked={phraseSaved}
            onChange={e => setPhraseSaved(e.target.checked)}
          />
          I've written down all 24 words in the correct order
        </label>

        <button
          className="auth__btn"
          onClick={handleContinue}
          disabled={!phraseSaved}
        >
          Continue
        </button>
      </div>
    );
  }

  // welcome step
  return (
    <div className="auth">
      <div className="auth__logo">δ</div>
      <h1 className="auth__title">Set up deltos</h1>
      <p className="auth__subtitle">
        deltos uses a passkey to protect your notes. Your data stays on this device
        and syncs end-to-end.
      </p>

      <button className="auth__btn auth__btn--primary" onClick={handleSetUp}>
        Set up with Passkey
      </button>

      <div className="auth__links">
        <Link to="/recover" className="auth__link">Recover an existing account</Link>
        <Link to="/qr-receive" className="auth__link">Join via QR code</Link>
      </div>
    </div>
  );
}
