/**
 * ActivitySection — the "Account activity" Settings surface (ROAD-0005 P3, the user-facing audit view).
 *
 * A live trust surface: lists the account's recent security events (sign-ins, connected-app access,
 * token/session changes, and blocked attempts) so the owner can self-audit anytime and catch anomalous
 * access AS IT HAPPENS — a sign-in from a place they don't recognise, a connected app (Claude) reading
 * more than expected, a token they never created — rather than only reaching for a forensic log after a
 * suspected breach. Read-only: this view surfaces signal; the kill-switches live in "Active sessions" and
 * "Connect to Claude".
 *
 * RESIDENCY (lazy off-track route): statically imported only by SettingsRoute, which is itself
 * `lazy()`-loaded in App.tsx, so it rides the settings chunk and never touches the mobile first-load
 * bundle. Its network client (`auditClient`) is likewise off the entry chunk.
 */
import { useCallback, useEffect, useState } from 'react';
import { listRecentActivity, ActivityError, type ActivityEvent } from '../lib/auditClient.js';

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A human-readable headline + tone for one event. `warn` flags denials / blocked attempts for the eye. */
function describe(e: ActivityEvent): { title: string; warn: boolean } {
  const denied = e.result === 'deny';
  switch (e.action) {
    case 'login':
      return denied
        ? { title: 'Failed sign-in attempt', warn: true }
        : { title: 'Signed in', warn: false };
    case 'token.mint':
      return denied
        ? { title: 'Blocked agent-token creation (failed verification)', warn: true }
        : { title: 'Connected an app (agent token created)', warn: false };
    case 'token.revoke':
      return { title: 'Revoked an agent token', warn: false };
    case 'session.revoke':
      return { title: 'Signed a device out', warn: false };
    case 'session.signout-others':
      return { title: 'Signed out other devices', warn: false };
    default:
      break;
  }
  // MCP / agent access — the connected-AI trail. `detail` carries the tool name.
  if (e.surface === 'mcp') {
    const tool = e.detail ? ` (${e.detail})` : '';
    return denied
      ? { title: `Connected app blocked${tool}`, warn: true }
      : { title: `Connected app accessed your notes${tool}`, warn: false };
  }
  if (denied) return { title: `Blocked request (${e.action})`, warn: true };
  return { title: e.action, warn: false };
}

/** A compact "from where / what" line: location (country · IP) when known. */
function whereLine(e: ActivityEvent): string | null {
  const bits = [e.country, e.ip].filter((x): x is string => Boolean(x));
  return bits.length ? bits.join(' · ') : null;
}

function messageFor(err: unknown): string {
  if (err instanceof ActivityError) return err.message;
  return 'Something went wrong — try again.';
}

export function ActivitySection() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setEvents(await listRecentActivity());
    } catch (err) {
      setEvents([]);
      setLoadError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="settings__section" aria-label="Account activity">
      <h2 className="settings__section-title">Account activity</h2>
      <p className="settings__row-hint">
        Recent sign-ins, connected-app access, and security changes on your account. Spot something you
        don&rsquo;t recognise? Sign out the device or disconnect the app above.
      </p>

      {events === null ? (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading activity…" />
        </div>
      ) : events.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">No recent activity.</span>
        </div>
      ) : (
        events.map((e) => {
          const { title, warn } = describe(e);
          const where = whereLine(e);
          return (
            <div key={e.id} className="settings__row">
              <span className="settings__token-row-main">
                <span className="settings__row-label">
                  {title}
                  {warn && <span className="settings__row-meta settings__row-meta--warn"> · blocked</span>}
                </span>
                <span className="settings__token-meta">
                  {formatWhen(e.ts)}
                  {where && <> · {where}</>}
                </span>
              </span>
            </div>
          );
        })
      )}

      {loadError && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{loadError}</p>
          <button className="settings__row-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
