import { useState, useMemo, useCallback } from 'react';
import type { Note } from '@deltos/shared';
import { noteText } from '../lib/textDelta.js';
import { formatSmartDate } from '../lib/notePreview.js';
import { useNotebooks } from '../db/storeHooks.js';
import { fileNoteAttachment, formatFileSize } from '../plugins/attachment/attachmentBlock.js';

/**
 * Full-screen per-note Info (ⓘ) panel — the sibling of HistoryPanel. Opened by the note meta bar's info
 * button (desktop) or the `?info` URL param (mobile), it shows common note metadata for EVERY note
 * (created / edited / notebook / word + char count / sync status) and, for file/PDF notes, the file-specific
 * rows (filename with rename, mime type, size, download).
 *
 * It mirrors HistoryPanel's outer shell (the `.history` full-screen container + sticky header) and reuses
 * the established `.file-view__metadata` / `.file-view__meta-row` dl look for the rows. Rename and Download
 * ride the exact paths the app already uses: rename persists through `onSave` (the same note-upsert/CAS path
 * NoteRoute wires for editing), and Download dynamic-imports the shared `downloadBlob` (GOTCHA-0001/0006
 * 403-remint blob fetch) rather than rolling its own URL logic.
 */
export interface InfoPanelProps {
  note: Note;
  onBack: () => void;
  /** Same note-upsert path NoteRoute passes the editor/file-view — used to persist a filename rename. */
  onSave: (note: Note) => Promise<void>;
}

/** Word + character count over the note's rendered text (title + body). */
function counts(text: string): { words: number; chars: number } {
  const trimmed = text.trim();
  return { words: trimmed ? trimmed.split(/\s+/).length : 0, chars: text.length };
}

export function InfoPanel({ note, onBack, onSave }: InfoPanelProps) {
  const notebooks = useNotebooks();
  // Null notebookId = the synthetic "All Notes" aggregate — the SAME label the shell renders for a null
  // notebook (App.tsx). A known id resolves to its name; an unresolved id falls back to an em dash.
  const notebookName = note.notebookId === null
    ? 'All Notes'
    : (notebooks.find((nb) => nb.id === note.notebookId)?.name ?? '—');

  const { words, chars } = useMemo(() => counts(noteText(note.title, note.body)), [note.title, note.body]);

  const att = fileNoteAttachment(note);
  const fileName = att?.name ?? '';
  const hash = att?.hash;

  // Download — reuse the shared blob client (the 403-remint fetch path), dynamic-imported so its heavy graph
  // never rides this panel's static bundle. Identical to FileNoteView.handleDownload.
  const handleDownload = useCallback(() => {
    if (!hash) return;
    void import('../plugins/attachment/blobClient.js').then(({ downloadBlob }) => downloadBlob(hash, fileName));
  }, [hash, fileName]);

  // Rename — edits the attachment `name` inside the note's first (attachment) block, and keeps note.title in
  // sync so the list/preview match. Persisted via onSave (fresh updatedAt + pending syncStatus), the same
  // note-upsert/CAS path an edit rides.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(fileName);
  const beginRename = useCallback(() => { setDraft(fileName); setRenaming(true); }, [fileName]);
  const submitRename = useCallback(async () => {
    const next = draft.trim();
    setRenaming(false);
    const block = note.body[0];
    if (!att || !block || !next || next === att.name) return;
    const updated: Note = {
      ...note,
      title: next,
      body: [
        { ...block, content: { ...(block.content as Record<string, unknown>), name: next } },
        ...note.body.slice(1),
      ],
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await onSave(updated);
  }, [draft, att, note, onSave]);

  return (
    <div className="history info">
      <div className="history__header">
        <button className="history__back" onClick={onBack} aria-label="Back to note">←</button>
        <h2 className="history__title">Info</h2>
      </div>
      <dl className="file-view__metadata">
        <div className="file-view__meta-row"><dt>Created</dt><dd>{formatSmartDate(note.createdAt)}</dd></div>
        <div className="file-view__meta-row"><dt>Edited</dt><dd>{formatSmartDate(note.updatedAt)}</dd></div>
        <div className="file-view__meta-row"><dt>Notebook</dt><dd>{notebookName}</dd></div>
        <div className="file-view__meta-row"><dt>Words</dt><dd>{words}</dd></div>
        <div className="file-view__meta-row"><dt>Characters</dt><dd>{chars}</dd></div>
        <div className="file-view__meta-row"><dt>Sync</dt><dd>{note.syncStatus}</dd></div>

        {att && (
          <>
            <div className="file-view__meta-row">
              <dt>Filename</dt>
              <dd>
                {renaming ? (
                  <form
                    className="info__rename"
                    onSubmit={(e) => { e.preventDefault(); void submitRename(); }}
                  >
                    <input
                      className="info__rename-input"
                      value={draft}
                      aria-label="Filename"
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void submitRename()}
                    />
                    <button type="submit" className="info__rename-save">Save</button>
                  </form>
                ) : (
                  <button type="button" className="info__rename-trigger" onClick={beginRename}>
                    {fileName || '(unnamed)'}
                  </button>
                )}
              </dd>
            </div>
            <div className="file-view__meta-row"><dt>Type</dt><dd>{att.mime || 'unknown'}</dd></div>
            <div className="file-view__meta-row"><dt>Size</dt><dd>{att.size > 0 ? formatFileSize(att.size) : '—'}</dd></div>
            <div className="file-view__meta-row">
              <dt>Download</dt>
              <dd>
                <button type="button" className="info__download" onClick={handleDownload} disabled={!hash}>
                  Download file
                </button>
              </dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}
