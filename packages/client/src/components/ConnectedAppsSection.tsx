/**
 * ConnectedAppsSection — the "Connected apps" Settings surface (oauth-provider.md §4, the owner-facing
 * management + kill-switch for OAuth-issued grants).
 *
 * Lists the apps connected via the one-click OAuth flow (Claude and any OAuth 2.1 MCP client) and lets the
 * owner disconnect any of them. This is the OAuth counterpart to "Connect to Claude" (which manages the
 * manual paste-token path): the server surfaces OAuth grants here, first-party agent tokens there.
 *
 * A single client can hold more than one grant (re-consent), so rows are GROUPED by clientId and Disconnect
 * is per-client — one tap revokes every grant that client holds (server: WHERE clientId=?). Disconnect is
 * optimistic: the group drops immediately, then the list refreshes from the server.
 *
 * RESIDENCY (lazy off-track route): statically imported only by SettingsRoute, which is itself
 * `lazy()`-loaded in App.tsx, so it rides the settings chunk and never touches the mobile first-load bundle.
 * Its network client (`oauthClient`) is likewise off the entry chunk.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listConnectedApps, disconnectApp, OAuthClientError, type ConnectedApp } from '../lib/oauthClient.js';

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function messageFor(err: unknown): string {
  if (err instanceof OAuthClientError) return err.message;
  return 'Something went wrong — try again.';
}

/** One connected client, folded from its (possibly several) grants: earliest connect + union of scopes. */
interface AppGroup {
  clientId: string;
  clientName: string | null;
  connectedAt: string; // earliest grant createdAt
  scopes: string[];
}

/** Fold the per-grant list the server returns into one row per client (re-consent yields multiple grants). */
function groupByClient(apps: ConnectedApp[]): AppGroup[] {
  const byClient = new Map<string, AppGroup>();
  for (const app of apps) {
    const existing = byClient.get(app.clientId);
    if (!existing) {
      byClient.set(app.clientId, {
        clientId: app.clientId,
        clientName: app.clientName,
        connectedAt: app.createdAt,
        scopes: [...app.scope],
      });
    } else {
      if (Date.parse(app.createdAt) < Date.parse(existing.connectedAt)) existing.connectedAt = app.createdAt;
      for (const s of app.scope) if (!existing.scopes.includes(s)) existing.scopes.push(s);
      if (!existing.clientName && app.clientName) existing.clientName = app.clientName;
    }
  }
  return [...byClient.values()].sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
}

/** A one-line "Connected · date · scope" description for a list row. */
function groupMeta(group: AppGroup): string {
  const scope = group.scopes.length ? group.scopes.join(', ') : 'read-only';
  return `Connected ${formatDate(group.connectedAt)} · ${scope}`;
}

export function ConnectedAppsSection() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setApps(await listConnectedApps());
    } catch (err) {
      setApps([]);
      setLoadError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => (apps ? groupByClient(apps) : []), [apps]);

  const handleDisconnect = async (clientId: string) => {
    setDisconnecting(clientId);
    // Optimistic: drop every grant for this client from the list immediately.
    setApps((prev) => (prev ? prev.filter((a) => a.clientId !== clientId) : prev));
    try {
      await disconnectApp(clientId);
      setConfirmDisconnect(null);
      await refresh();
    } catch (err) {
      setLoadError(messageFor(err));
      await refresh(); // reconcile — the optimistic drop may not have landed
    } finally {
      setDisconnecting(null);
    }
  };

  return (
    <section className="settings__section" aria-label="Connected apps">
      <h2 className="settings__section-title">Connected apps</h2>
      <p className="settings__row-hint">
        Apps connected with one-click sign-in (Claude and other MCP clients). Access is{' '}
        <strong>read-only</strong>. Disconnect any app to revoke it immediately.
      </p>

      {apps === null ? (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading connected apps…" />
        </div>
      ) : groups.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">No connected apps yet.</span>
        </div>
      ) : (
        groups.map((group) => {
          const isConfirming = confirmDisconnect === group.clientId;
          const isDisconnecting = disconnecting === group.clientId;
          const name = group.clientName || group.clientId;
          return (
            <div key={group.clientId} className="settings__row">
              <span className="settings__token-row-main">
                <span className="settings__row-label">{name}</span>
                <span className="settings__token-meta">{groupMeta(group)}</span>
              </span>
              {isConfirming ? (
                <>
                  <button
                    className="settings__row-action"
                    onClick={() => void handleDisconnect(group.clientId)}
                    disabled={isDisconnecting}
                    aria-label={`Confirm disconnect ${name}`}
                  >
                    {isDisconnecting ? 'Disconnecting…' : 'Confirm'}
                  </button>
                  <button
                    className="settings__row-action"
                    onClick={() => setConfirmDisconnect(null)}
                    disabled={isDisconnecting}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="settings__row-action"
                  onClick={() => setConfirmDisconnect(group.clientId)}
                  aria-label={`Disconnect ${name}`}
                >
                  Disconnect
                </button>
              )}
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
