/**
 * PhraseStep — presentational, zero store coupling. Shows the recovery phrase once and
 * gates Continue on the save-ack checkbox. Reused in two contexts:
 *
 *   1. RegisterRoute phrase step: onAck advances the local step machine (sync).
 *   2. ForcedPhraseRoute (recoveryRequired on login / cold-boot recovery-gate): onAck = finalizeAuth (async).
 *
 * Copy B (planSys @2cd2958): phrase = master key, one-way derivation, 2FA-bypass power.
 * Required ack checkbox is a secSys + planSys hard gate — Continue is disabled until checked.
 */
import { useState } from 'react';

interface PhraseStepProps {
  phrase: string;
  /** Called when the user checks the ack and taps Continue. May be async (finalizeAuth). */
  onAck: () => Promise<void> | void;
}

export function PhraseStep({ phrase, onAck }: PhraseStepProps) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const words = phrase.split(' ');

  const handleCopy = () => {
    void navigator.clipboard.writeText(phrase).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleContinue = () => {
    const result = onAck();
    if (result instanceof Promise) {
      setSubmitting(true);
      result.finally(() => setSubmitting(false));
    }
  };

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

      <button className="auth__btn" onClick={handleCopy} disabled={submitting}>
        {copied ? 'Copied!' : 'Copy phrase'}
      </button>

      {/* Required ack — copy B planSys @2cd2958 */}
      <label className="auth__checkbox-label">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          disabled={submitting}
        />
        I've saved my recovery phrase somewhere safe.
      </label>

      <button
        className="auth__btn auth__btn--primary"
        onClick={handleContinue}
        disabled={!saved || submitting}
      >
        {submitting ? 'Saving…' : 'Continue'}
      </button>
    </div>
  );
}
