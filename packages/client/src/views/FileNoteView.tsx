import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import type { NoteEditorProps } from '../editor/NoteEditor.js';
import { resolveFileIcon } from '../icons/index.js';
import { fileNoteAttachment, formatFileSize } from '../plugins/attachment/attachmentBlock.js';
import { formatSmartDate } from '../lib/notePreview.js';
import { mutateNotes } from '../db/mutate.js';
import { showActionToast } from '../lib/toastEvents.js';

/**
 * FileNoteView (file-notes.md §3.2, gates FN-6/FN-7) — the OPEN surface for a file note. It is the
 * note-type sibling of the attachment block: the whole note IS a foreign artifact, so a rich PM editor
 * would be wrong. Registered via `registerNoteView({ matches: isFileNote })` (see registerFileNoteView.ts),
 * it resolves INSTEAD of the block editor for a file note; normal notes are untouched (predicate miss →
 * the unconditional NoteEditor fallback).
 *
 * It satisfies NoteEditorProps but ignores `autoFocus` (nothing to focus) and uses `onSave` only for
 * Rename (a `title` write — a normal note upsert).
 *
 * Perf (north-star, gate FN-8): this whole module is a LAZY chunk (registerFileNoteView lazy()-wraps it),
 * never in the entry/editor bundle — it loads only when a file note is opened. The blob client (the heavy
 * fetch path) is additionally DYNAMIC-imported inside the preview effect + the download handler, mirroring
 * the FileNotePill pattern, so it never rides this chunk's static graph either.
 */

// Raster image mimes/extensions we attempt an inline preview for (the `…/:hash/view` WebP derivative). A
// miss (404 / not baked / non-image) falls back to the large format icon, so an over-broad guess is
// harmless. Mirrors FileNotePill.isThumbnailableImage (HEIC is shown via its WebP derivative, never raw).
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif']);
function isPreviewableImage(mime: string, name: string): boolean {
  if (IMAGE_MIMES.has(mime)) return true;
  return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name);
}

export function FileNoteView({ note, onSave }: NoteEditorProps) {
  const navigate = useNavigate();
  const att = fileNoteAttachment(note);
  const name = att?.name || note.title || 'File';
  const mime = att?.mime ?? '';
  const hash = att?.hash;

  const image = isPreviewableImage(mime, name);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  // Inline preview: the full-view `…/:hash/view` WebP derivative (NOT the square `.thumb`) — a plain
  // R2.get, no per-render transform. Dynamic-imported + session-cached (blobClient.urlCache). On reject
  // (404 / unbaked / offline) we degrade to the large format icon — never a broken <img>.
  useEffect(() => {
    if (!image || !hash) return;
    let alive = true;
    void import('../plugins/attachment/blobClient.js')
      .then(({ loadViewUrl }) => loadViewUrl(hash))
      .then((u) => { if (alive) setViewUrl(u); })
      .catch(() => { if (alive) setPreviewFailed(true); });
    return () => { alive = false; };
  }, [image, hash]);

  // Download: v1 fetches the ORIGINAL bytes via the existing attachment GET (downloadBlob → octet-stream).
  // NOTE / FLAG: the §4.3 image→JPEG on-the-fly transcode (env.IMAGES + Cache API) is a DEFERRED worker
  // concern, deliberately NOT built here — v1 downloads the raw original for every file kind.
  const handleDownload = useCallback(() => {
    if (!hash) return;
    void import('../plugins/attachment/blobClient.js').then(({ downloadBlob }) => downloadBlob(hash, name));
  }, [hash, name]);

  // Delete = soft-delete the NOTE (§6): the exact Trash path (sys:trashedAt, undoable, synced). The R2
  // blob + both WebP derivatives are intentionally LEFT for deferred orphan-GC. Then back to the list.
  const handleDelete = useCallback(() => {
    mutateNotes.softDelete(note).catch(console.error);
    showActionToast(`"${name}" deleted`, {
      label: 'Undo',
      fn: () => { mutateNotes.restore(note).catch(console.error); },
    });
    navigate('/');
  }, [note, name, navigate]);

  // Rename = edit the note `title` (the filename). Persisted via onSave (a normal note upsert), mirroring
  // NoteEditor's persistUpdate shape (fresh updatedAt + pending syncStatus → rides the same sync push).
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const beginRename = useCallback(() => { setDraft(name); setRenaming(true); }, [name]);
  const submitRename = useCallback(async () => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === note.title) return;
    const updated: Note = { ...note, title: next, updatedAt: new Date().toISOString(), syncStatus: 'pending' };
    await onSave(updated);
  }, [draft, note, onSave]);

  const Icon = resolveFileIcon(name, mime);
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const showImage = image && viewUrl && !previewFailed;

  return (
    <div className="editor file-view">
      <div className="file-view__inner">
        <header className="file-view__header">
          {renaming ? (
            <form
              className="file-view__rename"
              onSubmit={(e) => { e.preventDefault(); void submitRename(); }}
            >
              <input
                className="file-view__rename-input"
                value={draft}
                aria-label="Filename"
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void submitRename()}
              />
              <button type="submit" className="file-view__rename-save">Save</button>
            </form>
          ) : (
            <h1 className="file-view__title" title={name}>{name}</h1>
          )}
          <p className="file-view__sub">
            {[ext, mime || null, att && att.size > 0 ? formatFileSize(att.size) : null].filter(Boolean).join(' · ')}
          </p>
        </header>

        <div className="file-view__preview">
          {showImage ? (
            <img className="file-view__image" src={viewUrl!} alt={name} decoding="async" />
          ) : (
            <div className="file-view__nopreview">
              <span className="file-view__nopreview-icon" aria-hidden="true">
                <Icon size={72} />
              </span>
              {/* Non-image (pdf/office/unknown): a deliberate v1 boundary per the safe-serving design
                  (octet-stream + Content-Disposition: attachment), NOT a bug. Icon + Download is the path. */}
              {!image && <span className="file-view__nopreview-label">No preview available</span>}
            </div>
          )}
        </div>

        <div className="file-view__actions">
          <button type="button" className="file-view__action file-view__action--primary" onClick={handleDownload} disabled={!hash}>
            Download
          </button>
          <button type="button" className="file-view__action" onClick={beginRename}>
            Rename
          </button>
          <button type="button" className="file-view__action file-view__action--danger" onClick={handleDelete}>
            Delete
          </button>
        </div>

        <dl className="file-view__metadata">
          <div className="file-view__meta-row"><dt>Filename</dt><dd>{name}</dd></div>
          <div className="file-view__meta-row"><dt>Type</dt><dd>{mime || 'unknown'}</dd></div>
          <div className="file-view__meta-row"><dt>Size</dt><dd>{att ? formatFileSize(att.size) : '—'}</dd></div>
          <div className="file-view__meta-row"><dt>Edited</dt><dd>{formatSmartDate(note.updatedAt)}</dd></div>
        </dl>
      </div>
    </div>
  );
}
