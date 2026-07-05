import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Note } from '@deltos/shared';
import type { NoteEditorProps } from '../editor/NoteEditor.js';
import { resolveFileIcon } from '../icons/index.js';
import { fileNoteAttachment, formatFileSize } from '../plugins/attachment/attachmentBlock.js';
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

// PDF detection mirrors isPreviewableImage — mime-first, with a `.pdf` extension fallback (pdf-reader.md §2.1).
function isPdf(mime: string, name: string): boolean {
  return mime === 'application/pdf' || /\.pdf$/i.test(name);
}

// SECOND-LEVEL lazy import (pdf-reader.md §6.1, gate PDF-P): the PDF reader — and through it pdf.js — loads
// ONLY when a pdf file note actually opens. Because this is a dynamic `import()`, PdfReader/pdf.js never enter
// FileNoteView's STATIC import graph (which is itself already a lazy chunk off the entry bundle). Two lazy
// hops from first load; opening an image/normal note pulls zero pdf.js bytes.
const LazyPdfReader = lazy(() => import('./pdf/PdfReader.js').then((m) => ({ default: m.PdfReader })));

export function FileNoteView({ note, onSave }: NoteEditorProps) {
  const navigate = useNavigate();
  // ROAD-0014: a search hit inside a PDF deep-links here as `?page=N` → open the reader ON that page.
  const [searchParams] = useSearchParams();
  const pageParam = parseInt(searchParams.get('page') ?? '', 10);
  const initialPage = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : undefined;
  const att = fileNoteAttachment(note);
  const name = att?.name || note.title || 'File';
  const mime = att?.mime ?? '';
  const hash = att?.hash;

  const image = isPreviewableImage(mime, name);
  const pdf = isPdf(mime, name);
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

  // Header / actions / metadata are shared across both layouts (factored so the PDF branch can hoist the
  // preview OUT of the centered 680 column without duplicating this chrome).
  const header = (
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
  );

  const actions = (
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
  );

  // File metadata (Filename / Type / Size / Edited) moved OUT of the inline view into the per-note Info (ⓘ)
  // panel (InfoPanel.tsx) — the file view keeps only its primary open/preview + download/rename/delete
  // actions. The header sub-line still carries a compact type · size glance.

  // PDF layout (file-note preview rev, Jim): the reader is the DOMINANT surface — it escapes the 680 column
  // and flex-fills the full note-pane width + all remaining height below the meta bar, with its OWN internal
  // scroll (the min-height:0 chain lives in .file-view--pdf, styles.css). The header/actions/metadata stay in
  // the centered column ABOVE it, so the reader runs to the bottom of the pane. The in-app reader replaces the
  // old "No preview available" branch for pdfs; Suspense covers the second-level lazy chunk and the reader
  // degrades to the icon + Download itself on a parse/offline failure (gate PDF-2), so the chrome always works.
  if (pdf && hash) {
    return (
      <div className="editor file-view file-view--pdf">
        <div className="file-view__inner">
          {header}
          {actions}
        </div>
        <div className="file-view__preview file-view__preview--pdf">
          <Suspense fallback={<div className="pdf-reader__spinner" role="status">Loading reader…</div>}>
            <LazyPdfReader hash={hash} name={name} onDownload={handleDownload} initialPage={initialPage} />
          </Suspense>
        </div>
      </div>
    );
  }

  // Image / no-preview layout — unchanged: everything stays inside the centered 680 column, preview between
  // the header and the actions row.
  return (
    <div className="editor file-view">
      <div className="file-view__inner">
        {header}
        <div className="file-view__preview">
          {showImage ? (
            <img className="file-view__image" src={viewUrl!} alt={name} decoding="async" />
          ) : (
            <div className="file-view__nopreview">
              <span className="file-view__nopreview-icon" aria-hidden="true">
                <Icon size={72} />
              </span>
              {/* Non-image, non-pdf (office/unknown): a deliberate v1 boundary per the safe-serving design
                  (octet-stream + Content-Disposition: attachment), NOT a bug. Icon + Download is the path. */}
              {!image && <span className="file-view__nopreview-label">No preview available</span>}
            </div>
          )}
        </div>
        {actions}
      </div>
    </div>
  );
}
