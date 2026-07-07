import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Note } from '@deltos/shared';
import { useNotebooks } from '../db/storeHooks.js';
import { useAuthStore } from '../auth/store.js';
import { showToast } from '../lib/toastEvents.js';
import { useThemeStore } from '../lib/themeStore.js';
import { saveShareUrl, getShareUrls, deleteShareUrl } from '../db/shareUrls.js';
import {
  createShare,
  listShares,
  revokeShare,
  ShareError,
  type MintedShare,
  type ShareRecord,
  type ShareResourceType,
} from '../lib/shareApi.js';

/**
 * SharesPanel — the in-app surface to CREATE and MANAGE read-only share links for the open note and its
 * notebook (ROAD-0011 P2). Opened from the note action surface via the `?share` URL param, it mirrors
 * HistoryPanel / InfoPanel's full-screen overlay shell (`.history` container + sticky header).
 *
 * For the note (always) and its notebook (when the note lives in one — not the synthetic "All Notes"), it
 * offers a "Create share link" action that mints a link and surfaces the returned URL with a copy button,
 * and lists the resource's existing links each with a Revoke button (optimistic drop + refetch). The server
 * hash-stores the token (F6) and never re-serves it, so the URL is remembered CLIENT-LOCAL + account-isolated
 * (db/shareUrls.ts) to stay visible + copyable per row; a link minted on another device shows a "not saved
 * on this device" note + a Re-mint action instead.
 *
 * RESIDENCY (lazy off-track surface — CONV-0004 / plugins-lazy-past-first-paint): NoteRoute `lazy()`-loads
 * this as its OWN chunk on the `?share` param, so neither this panel nor its `shareApi` client ever enters
 * the mobile first-load bundle or the editor first-load path.
 */
export interface SharesPanelProps {
  /** The open note — the note itself is one share target; its `notebookId` supplies the notebook target. */
  note: Note;
  /** Dismiss the panel (NoteRoute clears the `?share` param). */
  onBack: () => void;
}

function messageFor(err: unknown): string {
  if (err instanceof ShareError) return err.message;
  return 'Something went wrong — try again.';
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One share target (a note or a notebook): the mint action, the once-shown minted URL, and the manage list
 * of existing links. Self-contained so the panel can drop in one per resource without duplicating state.
 *
 * The share token is hash-stored server-side (F6) and never re-served, so the list from `GET /api/shares`
 * carries no url. To keep each active link's URL visible with a Copy button, we remember minted urls
 * CLIENT-LOCAL + ACCOUNT-ISOLATED (db/shareUrls.ts) and look them up per row. A share with no local url
 * (minted on another device) renders a "link not saved on this device" note + a Re-mint action.
 */
function ShareTarget({
  resourceType,
  resourceId,
  heading,
  targetLabel,
  accountId,
}: {
  resourceType: ShareResourceType;
  resourceId: string;
  heading: string;
  targetLabel: string;
  /** Resident account — the isolation scope for the locally-remembered share urls. */
  accountId: string | null;
}) {
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedShare | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  // Which url was just copied (key = shareId, or 'minted' for the one-time reveal) — drives the "Copied!" flash.
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
      // Remember the url locally (account-isolated) BEFORE surfacing it, so it stays visible + copyable in the
      // list after the one-time reveal is dismissed (and across reopening the sheet on this device).
      await saveShareUrl(accountId, result.shareId, result.url);
      setUrls((prev) => ({ ...prev, [result.shareId]: result.url }));
      setMinted(result);
      void refresh(); // the new link appears in the list immediately (now WITH its remembered url)
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

      {minted ? (
        <div className="settings__token-box">
          <p className="settings__token-warning">
            Copy this link now — the URL is shown once and can&rsquo;t be retrieved again.
          </p>
          <textarea
            className="settings__token-value"
            readOnly
            rows={2}
            value={minted.url}
            aria-label="Share link"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="settings__token-box-actions">
            <button
              className="settings__row-action"
              onClick={() => void handleCopy(minted.url, 'minted')}
              aria-label="Copy share link"
            >
              {copiedKey === 'minted' ? 'Copied!' : 'Copy link'}
            </button>
            <button className="settings__row-action" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
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
      )}

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

export function SharesPanel({ note, onBack }: SharesPanelProps) {
  const notebooks = useNotebooks();
  // Resident account — the isolation scope for the locally-remembered share urls (db/shareUrls.ts).
  const accountId = useAuthStore((s) => s.accountId);
  // Null notebookId = the synthetic "All Notes" aggregate — no real notebook to share (App.tsx / InfoPanel
  // use the same rule). A known id resolves to its name; an unresolved id still shares by id.
  const notebookName = useMemo(() => {
    if (note.notebookId === null) return null;
    return notebooks.find((nb) => nb.id === note.notebookId)?.name ?? 'this notebook';
  }, [note.notebookId, notebooks]);

  const noteTitle = note.title.trim() || 'Untitled';

  return (
    <div className="history share">
      <div className="history__header">
        <button className="history__back" onClick={onBack} aria-label="Back to note">
          ←
        </button>
        <h2 className="history__title">Share</h2>
      </div>

      <ShareTarget
        resourceType="note"
        resourceId={note.id}
        heading="Share this note"
        targetLabel={`“${noteTitle}”`}
        accountId={accountId}
      />

      {note.notebookId !== null && notebookName !== null && (
        <ShareTarget
          resourceType="notebook"
          resourceId={note.notebookId}
          heading="Share this notebook"
          targetLabel={`the notebook “${notebookName}”`}
          accountId={accountId}
        />
      )}
    </div>
  );
}
