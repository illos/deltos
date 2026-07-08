import { useCallback, useEffect, useState } from 'react';
import { showToast } from '../lib/toastEvents.js';
import { useThemeStore } from '../lib/themeStore.js';
import { saveShareUrl, getShareUrls, deleteShareUrl } from '../db/shareUrls.js';
import {
  createShare,
  listShares,
  revokeShare,
  ShareError,
  type ShareRecord,
  type ShareResourceType,
} from '../lib/shareApi.js';

/**
 * ShareTarget — one share target (a note OR a notebook): the mint action + the manage list of existing
 * links. EXTRACTED from ShareLinkSection (notebook-menu-and-keep-view.md §4.3) so the SAME component mounts
 * in TWO contexts — the note Share screen (`resourceType='note'`) and the notebook "…" menu
 * (`resourceType='notebook'`, keyed by the current notebook id). Zero logic change from its old inline home;
 * one component, two mount points. The notebook-share feature (mint / grant / `/s/<token>` public render /
 * revoke) is ALREADY complete end-to-end on the server — this is an IA MOVE, not a new feature, so nothing in
 * `shareApi` or the worker changes.
 *
 * Minting has NO separate reveal dialog — the new link simply appears in the list below with its own URL +
 * Copy. Self-contained so a panel can drop in one per resource without duplicating state. The share token is
 * hash-stored server-side (F6) and never re-served, so the list from `GET /api/shares` carries no url. To keep
 * each active link's URL visible with a Copy button, we remember minted urls CLIENT-LOCAL + ACCOUNT-ISOLATED
 * (db/shareUrls.ts) and look them up per row. A share with no local url (minted on another device) renders a
 * "link not saved on this device" note + a Re-mint action.
 *
 * RESIDENCY (lazy off-track — CONV-0004 / plugins-lazy-past-first-paint): this module pulls `shareApi`, so it
 * must stay OFF the first-load bundle. The note Share screen already guarantees this via the lazy
 * ShareExportPanel chunk; the notebook menu lazy-imports it on expansion (see NotebookMenuBody).
 */

function messageFor(err: unknown): string {
  if (err instanceof ShareError) return err.message;
  return 'Something went wrong — try again.';
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface ShareTargetProps {
  resourceType: ShareResourceType;
  resourceId: string;
  heading: string;
  targetLabel: string;
  /** Resident account — the isolation scope for the locally-remembered share urls. */
  accountId: string | null;
}

export function ShareTarget({ resourceType, resourceId, heading, targetLabel, accountId }: ShareTargetProps) {
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // Which url was just copied (key = shareId) — drives the per-row "Copied!" flash.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // shareId → locally-remembered url, for the rows whose url this device minted. Absent = not saved here.
  const [urls, setUrls] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listShares(resourceType, resourceId);
      setShares(list);
      // Hydrate the locally-known urls for exactly these shares (account-scoped) so each row can show + copy it.
      setUrls(await getShareUrls(accountId, list.map((s) => s.shareId)));
    } catch (err) {
      setShares([]);
      setLoadError(messageFor(err));
    }
  }, [resourceType, resourceId, accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setMinting(true);
    setMintError(null);
    setCopiedKey(null);
    try {
      // Stamp the owner's CURRENT theme (palette+voice) onto the share so the public render matches it.
      const { palette, voice } = useThemeStore.getState();
      const result = await createShare(resourceType, resourceId, { palette, voice });
      // Remember the url locally (account-isolated) BEFORE the list refresh, so the new row shows it inline
      // (and it survives reopening the sheet on this device). No separate reveal step — the row IS the reveal.
      await saveShareUrl(accountId, result.shareId, result.url);
      setUrls((prev) => ({ ...prev, [result.shareId]: result.url }));
      showToast('Share link created');
      void refresh(); // the new link appears in the list immediately (WITH its remembered url + Copy)
    } catch (err) {
      setMintError(messageFor(err));
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async (url: string, key: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      showToast('Share link copied');
      window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied) — the field stays selectable as the fallback.
    }
  };

  const handleRevoke = async (shareId: string) => {
    setRevoking(shareId);
    // Optimistic: drop the link from the list immediately, then reconcile from the server.
    setShares((prev) => (prev ? prev.filter((s) => s.shareId !== shareId) : prev));
    setUrls((prev) => {
      const next = { ...prev };
      delete next[shareId];
      return next;
    });
    void deleteShareUrl(accountId, shareId); // forget the local url too — the link is dead
    try {
      await revokeShare(shareId);
      await refresh();
    } catch (err) {
      setLoadError(messageFor(err));
      await refresh(); // reconcile — the optimistic drop may not have landed
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="settings__section" aria-label={heading}>
      <h2 className="settings__section-title">{heading}</h2>
      <p className="settings__row-hint">
        Create a <strong>read-only</strong> link to {targetLabel}. Anyone with the link can view it — revoke
        it any time to kill access.
      </p>

      <div className="settings__row settings__row--btn-group">
        <button
          className="settings__row-action"
          onClick={() => void handleCreate()}
          disabled={minting}
          aria-label={`Create share link for ${targetLabel}`}
        >
          {minting ? 'Creating…' : 'Create share link'}
        </button>
      </div>

      {mintError && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{mintError}</p>
        </div>
      )}

      {/* ── Existing links ──────────────────────────────────────────────── */}
      {shares === null ? (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading share links…" />
        </div>
      ) : shares.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">No share links yet.</span>
        </div>
      ) : (
        shares.map((share) => {
          const isRevoking = revoking === share.shareId;
          const url = urls[share.shareId];
          return (
            <div key={share.shareId} className="settings__row settings__share-row">
              <div className="settings__share-row-head">
                <span className="settings__token-row-main">
                  <span className="settings__row-label">Share link</span>
                  <span className="settings__token-meta">Created {formatDate(share.createdAt)}</span>
                </span>
                <button
                  className="settings__row-action"
                  onClick={() => void handleRevoke(share.shareId)}
                  disabled={isRevoking}
                  aria-label={`Revoke share link created ${formatDate(share.createdAt)}`}
                >
                  {isRevoking ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
              {url ? (
                // The url was minted on THIS device (remembered locally) — show it, readonly + copyable.
                <div className="settings__share-url">
                  <input
                    className="settings__token-value"
                    readOnly
                    value={url}
                    aria-label={`Share link created ${formatDate(share.createdAt)}`}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    className="settings__row-action"
                    onClick={() => void handleCopy(url, share.shareId)}
                    aria-label={`Copy share link created ${formatDate(share.createdAt)}`}
                  >
                    {copiedKey === share.shareId ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              ) : (
                // The url isn't remembered on this device (minted elsewhere) — offer a fresh mint.
                <div className="settings__share-url settings__share-url--absent">
                  <span className="settings__token-meta">link not saved on this device</span>
                  <button
                    className="settings__row-action"
                    onClick={() => void handleCreate()}
                    disabled={minting}
                    aria-label="Re-mint share link"
                  >
                    {minting ? 'Creating…' : 'Re-mint'}
                  </button>
                </div>
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
