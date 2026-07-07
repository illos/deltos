import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Note } from '@deltos/shared';
import { useNotebooks } from '../db/storeHooks.js';
import { showToast } from '../lib/toastEvents.js';
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
 * offers a "Create share link" action that mints a link, surfaces the returned URL ONCE with a copy
 * button (the token is never recoverable — the list can't re-show it), and lists the resource's existing
 * links each with a Revoke button (optimistic drop + refetch).
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
 */
function ShareTarget({
  resourceType,
  resourceId,
  heading,
  targetLabel,
}: {
  resourceType: ShareResourceType;
  resourceId: string;
  heading: string;
  targetLabel: string;
}) {
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedShare | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setShares(await listShares(resourceType, resourceId));
    } catch (err) {
      setShares([]);
      setLoadError(messageFor(err));
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setMinting(true);
    setMintError(null);
    setCopied(false);
    try {
      const result = await createShare(resourceType, resourceId);
      setMinted(result);
      void refresh(); // the new link appears in the list immediately (without its token)
    } catch (err) {
      setMintError(messageFor(err));
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      showToast('Share link copied');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied) — the field stays selectable as the fallback.
    }
  };

  const handleRevoke = async (shareId: string) => {
    setRevoking(shareId);
    // Optimistic: drop the link from the list immediately, then reconcile from the server.
    setShares((prev) => (prev ? prev.filter((s) => s.shareId !== shareId) : prev));
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
              onClick={() => void handleCopy(minted.url)}
              aria-label="Copy share link"
            >
              {copied ? 'Copied!' : 'Copy link'}
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
          return (
            <div key={share.shareId} className="settings__row">
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
      />

      {note.notebookId !== null && notebookName !== null && (
        <ShareTarget
          resourceType="notebook"
          resourceId={note.notebookId}
          heading="Share this notebook"
          targetLabel={`the notebook “${notebookName}”`}
        />
      )}
    </div>
  );
}
