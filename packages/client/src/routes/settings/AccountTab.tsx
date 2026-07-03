/**
 * AccountTab — Account identity + the security controls folded in from the old Security section
 * (Jim's binding 6-tab deviation): Sign out, Recovery phrase, Two-factor.
 *
 * The `View` state machine (sign-out confirm, recovery-phrase regenerate, 2FA enable QR+verify /
 * disable code) is re-homed VERBATIM from the old single-scroll SettingsRoute — behavior-preserving.
 * Each sub-view renders in the shared SettingsPane so chrome stays consistent; its back / Cancel
 * returns to the Account list ('list' view), not the whole Settings list.
 *
 * 2FA: verifyTotp (enable) and disableTotp (disable) both require a TOTP code. The server revokes
 * other sessions and re-issues a fresh bearer for THIS device (secSys #43 ruling @3340816) — no
 * forced re-login; the store swaps bearerToken internally and totpEnabled flips on success.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore } from '../../auth/store.js';
import type {
  TotpSetupResult,
  TotpVerifyResult,
  TotpDisableResult,
  SessionState,
} from '../../auth/store.js';
import { PhraseStep } from '../../components/PhraseStep.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

function sessionLabel(s: SessionState): string {
  switch (s) {
    case 'active': return 'Synced / Online';
    case 'offline': return 'Offline — changes saved locally';
    case 'revoked': return 'Signed out — sign in to resume sync';
    case 'unauthed': return 'Not signed in';
    case 'booting': return 'Connecting…';
  }
}

type View =
  | { tag: 'list' }
  | { tag: 'signout-confirm'; busy: boolean; error?: string }
  | { tag: 'phrase-confirm' }
  | { tag: 'phrase-busy' }
  | { tag: 'phrase-show'; phrase: string }
  | { tag: 'phrase-error'; error: string }
  | { tag: 'totp-enable-busy' }
  | { tag: 'totp-enable-setup'; uri: string; code: string; error?: string; busy: boolean }
  | { tag: 'totp-disable-confirm'; code: string; busy: boolean; error?: string };

export function AccountTab({ variant }: { variant: SettingsVariant }) {
  const username = useAuthStore((s) => s.username);
  const accountId = useAuthStore((s) => s.accountId);
  const sessionState = useAuthStore((s) => s.sessionState);
  const logout = useAuthStore((s) => s.logout);
  const establishRecovery = useAuthStore((s) => s.establishRecovery);
  const setupTotp = useAuthStore((s) => s.setupTotp);
  const verifyTotp = useAuthStore((s) => s.verifyTotp);
  const disableTotp = useAuthStore((s) => s.disableTotp);
  const totpEnabled = useAuthStore((s) => s.totpEnabled);

  const navigate = useNavigate();
  const [view, setView] = useState<View>({ tag: 'list' });

  // Back to the Account list (sub-view Cancel / header back).
  const toList = () => setView({ tag: 'list' });

  // ── Sign out ─────────────────────────────────────────────────────────────

  const handleSignOut = () => setView({ tag: 'signout-confirm', busy: false });

  const handleSignOutConfirm = () => {
    setView({ tag: 'signout-confirm', busy: true });
    logout().then(() => {
      navigate('/login', { replace: true });
    }).catch(() => {
      setView({ tag: 'signout-confirm', busy: false, error: 'Something went wrong — try again' });
    });
  };

  // ── Recovery phrase ──────────────────────────────────────────────────────

  const handleRegenPhrase = () => {
    setView({ tag: 'phrase-busy' });
    establishRecovery().then((r) => {
      if (r.ok) {
        setView({ tag: 'phrase-show', phrase: r.recoveryPhrase });
      } else {
        setView({ tag: 'phrase-error', error: 'Could not generate a new phrase — try again' });
      }
    }).catch(() => {
      setView({ tag: 'phrase-error', error: 'Connection error — try again' });
    });
  };

  // ── TOTP enable ──────────────────────────────────────────────────────────

  const handleTotpEnable = () => {
    setView({ tag: 'totp-enable-busy' });
    setupTotp().then((r: TotpSetupResult) => {
      if (r.ok) {
        setView({ tag: 'totp-enable-setup', uri: r.uri, code: '', busy: false });
      } else {
        setView({ tag: 'list' });
      }
    }).catch(() => setView({ tag: 'list' }));
  };

  const handleTotpVerify = () => {
    if (view.tag !== 'totp-enable-setup') return;
    const capturedUri = view.uri;
    const capturedCode = view.code;
    setView({ tag: 'totp-enable-setup', uri: capturedUri, code: capturedCode, busy: true });
    verifyTotp(capturedCode).then((r: TotpVerifyResult) => {
      if (r.ok) {
        // Server revokes others + re-issues bearer for this device (secSys #43 @3340816);
        // store swaps bearerToken + flips totpEnabled internally — just return to list.
        setView({ tag: 'list' });
      } else {
        setView({ tag: 'totp-enable-setup', uri: capturedUri, code: capturedCode, error: 'Incorrect code — try again', busy: false });
      }
    }).catch(() => {
      setView({ tag: 'totp-enable-setup', uri: capturedUri, code: capturedCode, error: 'Connection error — try again', busy: false });
    });
  };

  // ── TOTP disable ─────────────────────────────────────────────────────────

  const handleTotpDisable = () => setView({ tag: 'totp-disable-confirm', code: '', busy: false });

  const handleTotpDisableConfirm = () => {
    if (view.tag !== 'totp-disable-confirm') return;
    const capturedCode = view.code;
    setView({ tag: 'totp-disable-confirm', code: capturedCode, busy: true });
    disableTotp(capturedCode).then((r: TotpDisableResult) => {
      if (r.ok) {
        // Server revokes others + re-issues bearer; store flips totpEnabled — return to list.
        setView({ tag: 'list' });
      } else if (r.code === 'totp_invalid') {
        setView({ tag: 'totp-disable-confirm', code: capturedCode, busy: false, error: 'Incorrect code — try again' });
      } else {
        setView({ tag: 'totp-disable-confirm', code: capturedCode, busy: false, error: 'Something went wrong — try again' });
      }
    }).catch(() => {
      setView({ tag: 'totp-disable-confirm', code: capturedCode, busy: false, error: 'Connection error — try again' });
    });
  };

  // ── Sub-views ─────────────────────────────────────────────────────────────

  if (view.tag === 'signout-confirm') {
    return (
      <SettingsPane variant={variant} title="Sign out?" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <p className="settings__confirm-body">
            Signing out clears this device&rsquo;s session. You&rsquo;ll re-enter your
            username and password to sync on this device again.
          </p>
          {view.error && <p className="settings__error">{view.error}</p>}
          <button
            className="settings__action settings__action--danger"
            onClick={handleSignOutConfirm}
            disabled={view.busy}
          >
            {view.busy ? 'Signing out…' : 'Sign out'}
          </button>
          <button className="settings__action" onClick={toList} disabled={view.busy}>
            Cancel
          </button>
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'phrase-confirm') {
    return (
      <SettingsPane variant={variant} title="Recovery phrase" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <p className="settings__confirm-body">
            Regenerating creates a <strong>new</strong> recovery phrase and immediately
            invalidates the old one. The new phrase is shown once — you cannot view it
            again. Store it somewhere safe before continuing.
          </p>
          <button className="settings__action settings__action--primary" onClick={handleRegenPhrase}>
            Regenerate phrase
          </button>
          <button className="settings__action" onClick={toList}>Cancel</button>
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'phrase-busy') {
    return (
      <SettingsPane variant={variant} title="Recovery phrase" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <div className="auth__spinner" aria-label="Generating phrase…" />
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'phrase-error') {
    return (
      <SettingsPane variant={variant} title="Recovery phrase" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <p className="settings__error">{view.error}</p>
          <button className="settings__action" onClick={handleRegenPhrase}>Try again</button>
          <button className="settings__action" onClick={toList}>Cancel</button>
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'phrase-show') {
    // PhraseStep renders its own full-screen auth container; onAck returns to the list.
    return <PhraseStep phrase={view.phrase} onAck={toList} />;
  }

  if (view.tag === 'totp-enable-busy') {
    return (
      <SettingsPane variant={variant} title="Enable 2FA" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <div className="auth__spinner" aria-label="Setting up 2FA…" />
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'totp-enable-setup') {
    return (
      <SettingsPane variant={variant} title="Enable 2FA" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <p className="settings__confirm-body">
            Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
          </p>
          <p className="settings__row-hint">
            2FA is required only at new-device sign-in and after a reset — never at regular app launch.
          </p>
          <div className="auth__qr">
            <QRCodeSVG value={view.uri} size={200} bgColor="transparent" fgColor="currentColor" />
          </div>
          <input
            className="auth__input auth__totp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={view.code}
            onChange={(e) => {
              if (view.tag !== 'totp-enable-setup') return;
              setView({ ...view, code: e.target.value.replace(/\D/g, '') });
            }}
            aria-label="6-digit verification code"
            disabled={view.busy}
          />
          {view.error && <p className="settings__error">{view.error}</p>}
          <button
            className="settings__action settings__action--primary"
            onClick={handleTotpVerify}
            disabled={view.code.length < 6 || view.busy}
          >
            {view.busy ? 'Verifying…' : 'Verify and enable 2FA'}
          </button>
          <button className="settings__action" onClick={toList} disabled={view.busy}>
            Cancel
          </button>
        </div>
      </SettingsPane>
    );
  }

  if (view.tag === 'totp-disable-confirm') {
    return (
      <SettingsPane variant={variant} title="Disable 2FA" onBack={toList} backLabel="Account">
        <div className="settings__section">
          <p className="settings__confirm-body">
            Enter your current authenticator code to confirm. Disabling 2FA removes the
            extra code step at new-device sign-in.
          </p>
          <input
            className="auth__input auth__totp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={view.code}
            onChange={(e) => {
              if (view.tag !== 'totp-disable-confirm') return;
              setView({ ...view, code: e.target.value.replace(/\D/g, '') });
            }}
            aria-label="Authenticator code to disable 2FA"
            disabled={view.busy}
          />
          {view.error && <p className="settings__error">{view.error}</p>}
          <button
            className="settings__action settings__action--danger"
            onClick={handleTotpDisableConfirm}
            disabled={view.code.length < 6 || view.busy}
          >
            {view.busy ? 'Disabling…' : 'Disable 2FA'}
          </button>
          <button className="settings__action" onClick={toList} disabled={view.busy}>
            Cancel
          </button>
        </div>
      </SettingsPane>
    );
  }

  // ── Account list (default) ─────────────────────────────────────────────────

  return (
    <SettingsPane variant={variant} title="Account" onBack={() => navigate('/settings')} backLabel="Settings">
      {/* Identity */}
      <section className="settings__section" aria-label="Account">
        <div className="settings__row">
          <span className="settings__row-label">Username</span>
          <span className="settings__row-value">{username ?? '—'}</span>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">Account ID</span>
          <span className="settings__row-value settings__row-value--mono settings__row-value--muted">
            {accountId ?? '—'}
          </span>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">Sync</span>
          <span className="settings__row-value settings__row-value--muted">
            {sessionLabel(sessionState)}
          </span>
        </div>
      </section>

      {/* Security controls (folded in from the old Security section — Jim's 6-tab deviation). */}
      <section className="settings__section" aria-label="Security">
        <h2 className="settings__section-title">Security</h2>
        <button className="settings__row settings__row--btn" onClick={handleSignOut}>
          <span className="settings__row-label settings__row-label--danger">Sign out</span>
          <span className="settings__row-chevron" aria-hidden>›</span>
        </button>
        <button className="settings__row settings__row--btn" onClick={() => setView({ tag: 'phrase-confirm' })}>
          <span className="settings__row-label">Recovery phrase</span>
          <span className="settings__row-meta">Regenerate</span>
          <span className="settings__row-chevron" aria-hidden>›</span>
        </button>
        <div className="settings__row settings__row--totp">
          <span className="settings__row-label">Two-factor authentication</span>
          <span className="settings__row-meta settings__row-meta--muted" aria-label={`2FA ${totpEnabled ? 'enabled' : 'disabled'}`}>
            {totpEnabled ? 'On' : 'Off'}
          </span>
          {totpEnabled ? (
            <button className="settings__row-action" onClick={handleTotpDisable} aria-label="Disable 2FA">
              Disable
            </button>
          ) : (
            <button className="settings__row-action" onClick={handleTotpEnable} aria-label="Enable 2FA">
              Enable
            </button>
          )}
        </div>
        <p className="settings__row-hint">
          2FA is required only at new-device sign-in and after a reset — never at regular app launch.
        </p>
      </section>
    </SettingsPane>
  );
}
