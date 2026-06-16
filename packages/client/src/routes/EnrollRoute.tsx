/**
 * EnrollRoute — first-time device setup and mnemonic display.
 *
 * Flow:
 *   welcome → [button click] → enrolling → mnemonic-display → [save confirmed] →
 *   registering → session-mint → username-claim → done
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
 *
 * Username claim (F-acct-4): the username step fires AFTER mintSession() — authenticated-claim-only.
 * No standalone availability oracle: "taken" is revealed only through the POST /api/auth/username
 * response. Client-side normalizeUsername validates FORMAT only (pure, no server round-trip).
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  normalizeUsername,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  type UsernameRejectReason,
} from '@deltos/shared';
import { useAuthStore, detectDeviceLabel } from '../auth/store.js';
import { encodeQrPayload } from '../identity/qrJoin.js';
import { Disclosure } from '../components/Disclosure.js';

type Step =
  | { tag: 'welcome' }
  | { tag: 'busy'; msg: string }
  | { tag: 'mnemonic'; mnemonic: string; usesPrf: boolean }
  | { tag: 'username' }
  | { tag: 'error'; msg: string };

function usernameHintMessage(reason: UsernameRejectReason): string {
  switch (reason) {
    case 'empty': return '';
    case 'too-short': return `Must be at least ${USERNAME_MIN_LENGTH} characters`;
    case 'too-long': return `Must be at most ${USERNAME_MAX_LENGTH} characters`;
    case 'charset': return 'Use only letters a–z, digits 0–9, hyphens, and underscores';
    case 'leading': return 'Must start with a letter or number';
    case 'control': return 'Username contains invalid characters';
    case 'reserved': return 'That name is reserved';
    default: return 'Invalid username';
  }
}

export function EnrollRoute() {
  const { enroll, register, mintSession, claimUsername, finalizeEnroll } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ tag: 'welcome' });
  const [phraseSaved, setPhraseSaved] = useState(false);
  const [showQr, setShowQr] = useState(false);

  // Username step local state
  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

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
        setStep({ tag: 'username' });
      })
      .catch((e: Error) => {
        setStep({ tag: 'error', msg: e.message });
      });
  };

  const handleClaim = () => {
    if (step.tag !== 'username') return;
    // Client-side format guard (pure — no server call, no oracle)
    const norm = normalizeUsername(username);
    if (!norm.ok) return;
    setClaiming(true);
    setUsernameError(null);
    claimUsername(username)
      .then(result => {
        if (result.ok || result.code === 'account-has-username') {
          finalizeEnroll();
          navigate('/', { replace: true });
        } else if (result.code === 'name-taken') {
          setClaiming(false);
          setUsernameError('That name is taken — try another');
        } else if (result.code === 'invalid') {
          setClaiming(false);
          setUsernameError('Invalid username format');
        } else {
          setClaiming(false);
          setUsernameError('Something went wrong, please try again');
        }
      })
      .catch(() => {
        setClaiming(false);
        setUsernameError('Something went wrong, please try again');
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

        {/* Security disclosure — establishment point (planSys ruling): enroll only, never launch path */}
        <Disclosure />

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

  if (step.tag === 'username') {
    // Client-side FORMAT hint only — pure, no server call (F-acct-4: no availability oracle).
    // "Taken" is revealed only by the authenticated POST response.
    const hint = username.length > 0 ? normalizeUsername(username) : null;
    const formatError = hint && !hint.ok && hint.reason !== 'empty'
      ? usernameHintMessage(hint.reason)
      : null;
    const canSubmit = !formatError && (hint?.ok ?? false) && !claiming;

    return (
      <div className="auth">
        <h1 className="auth__title">Choose a handle</h1>
        <p className="auth__subtitle">
          Pick a username for your deltos account. You can always skip this for now.
        </p>

        <input
          className="auth__input"
          type="text"
          value={username}
          onChange={e => { setUsername(e.target.value); setUsernameError(null); }}
          placeholder="your-handle"
          autoCapitalize="none"
          autoComplete="username"
          aria-label="Username"
          aria-describedby={formatError ?? usernameError ? 'username-error' : undefined}
        />

        {(formatError ?? usernameError) && (
          <p id="username-error" className="auth__error">{formatError ?? usernameError}</p>
        )}

        <button
          className="auth__btn auth__btn--primary"
          disabled={!canSubmit}
          onClick={handleClaim}
        >
          {claiming ? 'Claiming…' : 'Claim'}
        </button>

        <button
          className="auth__link"
          onClick={() => { finalizeEnroll(); navigate('/', { replace: true }); }}
        >
          Skip for now
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
        Your notes live on this device, protected by its lock screen — and sync across your devices.
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
