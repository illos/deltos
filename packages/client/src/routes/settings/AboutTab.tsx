/**
 * AboutTab — version + build stamp, the manual "Update now" (pwa-force-update) control, the app
 * lede, and the Diagnostics snapshot export. Re-homed verbatim from the old About/Diagnostics
 * sections of the single-scroll SettingsRoute.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forceUpdate } from '../../lib/forceUpdate.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

// Render the injected ISO build timestamp as a compact local date+time so Jim can eyeball "did my latest
// deploy actually land on this device?". Falls back to the raw value if unparseable.
function formatBuildTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AboutTab({ variant }: { variant: SettingsVariant }) {
  const navigate = useNavigate();

  // ── App update (pwa-force-update) ──────────────────────────────────────────
  // Manual ONLY: tapping forces a fresh server check and, if a new build is waiting, activates it
  // and reloads. Never auto-applies. 'updating' leaves the button busy because a reload is in flight.
  const [updateStatus, setUpdateStatus] =
    useState<'idle' | 'checking' | 'updating' | 'latest' | 'offline'>('idle');

  const handleUpdate = () => {
    if (updateStatus === 'checking' || updateStatus === 'updating') return;
    setUpdateStatus('checking');
    forceUpdate()
      .then((outcome) => {
        switch (outcome) {
          case 'updating':
            setUpdateStatus('updating'); // a reload is in flight; keep the busy state
            break;
          case 'offline':
            setUpdateStatus('offline');
            break;
          case 'latest':
          case 'unsupported':
            setUpdateStatus('latest');
            break;
        }
      })
      .catch(() => setUpdateStatus('offline'));
  };

  // ── Diagnostic snapshot (dev troubleshooting) ──────────────────────────────
  // Dynamically imports the snapshot builder + fflate ON CLICK (FN-8 lazy-split) so neither rides the
  // entry chunk. Builds a zip of local IndexedDB + env (token/secret/key redacted) and downloads it.
  const [snapshotStatus, setSnapshotStatus] = useState<'idle' | 'building' | 'error'>('idle');

  const handleExportSnapshot = () => {
    if (snapshotStatus === 'building') return;
    setSnapshotStatus('building');
    import('../../lib/diagnosticSnapshot.js')
      .then((m) => m.exportDiagnosticSnapshot())
      .then(() => setSnapshotStatus('idle'))
      .catch(() => setSnapshotStatus('error'));
  };

  const updateBusy = updateStatus === 'checking' || updateStatus === 'updating';
  const updateLabel =
    updateStatus === 'checking' ? 'Checking…' : updateStatus === 'updating' ? 'Updating…' : 'Update now';
  const updateHint =
    updateStatus === 'latest'
      ? "You're on the latest version."
      : updateStatus === 'offline'
        ? 'Connect to the internet to check for updates.'
        : null;

  return (
    <SettingsPane variant={variant} title="About" onBack={() => navigate('/settings')}>
      <section className="settings__section" aria-label="About">
        <div className="settings__row">
          <span className="settings__row-label">Version</span>
          <span className="settings__row-value settings__row-value--mono settings__row-value--muted">
            {__APP_VERSION__}
          </span>
        </div>
        <div className="settings__row">
          <span className="settings__row-label">Build</span>
          <span className="settings__row-value settings__row-value--mono settings__row-value--muted">
            {formatBuildTime(__BUILD_TIME__)}
          </span>
        </div>
        {/* Manual update — forces a fresh check against the server (the reliable path on iOS) and,
            if a new build is waiting, activates it and reloads. Never auto-applies. */}
        <button
          className="settings__row settings__row--btn"
          onClick={handleUpdate}
          disabled={updateBusy}
          aria-label="Update now"
        >
          <span className="settings__row-label">{updateLabel}</span>
          <span className="settings__row-chevron" aria-hidden>›</span>
        </button>
        {updateHint && <p className="settings__row-hint">{updateHint}</p>}
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">
            deltos — your notes, under your control. Local-first, synced, private.
          </span>
        </div>
      </section>

      {/* Diagnostics: hand a local-state snapshot to support for troubleshooting. */}
      <section className="settings__section" aria-label="Diagnostics">
        <h2 className="settings__section-title">Diagnostics</h2>
        <button
          className="settings__row settings__row--btn"
          onClick={handleExportSnapshot}
          disabled={snapshotStatus === 'building'}
          aria-label="Export snapshot"
        >
          <span className="settings__row-label">
            {snapshotStatus === 'building' ? 'Building…' : 'Export snapshot'}
          </span>
          <span className="settings__row-chevron" aria-hidden>›</span>
        </button>
        <p className="settings__row-hint">
          Includes your notes + app state for troubleshooting. Excludes passwords, tokens, and keys.
        </p>
        {snapshotStatus === 'error' && (
          <p className="settings__error">Could not build the snapshot — try again.</p>
        )}
      </section>
    </SettingsPane>
  );
}
