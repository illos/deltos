import { useState } from 'react';
import type { Note } from '@deltos/shared';
import { showToast } from '../lib/toastEvents.js';
import { exportMarkdown, printNote } from '../lib/exportNote.js';

/**
 * ExportPanel — the in-app surface for ROAD-0017 export controls on the open note: Export as Markdown,
 * Export as PDF, and Print. Opened from the note action surface via the `?export` URL param, it mirrors
 * SharesPanel / HistoryPanel / InfoPanel's full-screen overlay shell (`.history` container + sticky header).
 *
 * RESIDENCY (lazy off-track surface — CONV-0004 / plugins-lazy-past-first-paint): NoteRoute `lazy()`-loads
 * this as its OWN chunk on the `?export` param, so neither this panel nor the export serializers/print
 * machinery it pulls in (`exportNote` → shared serializers + the attachment blob client) ever enter the
 * mobile first-load bundle or the editor first-load path.
 *
 * Print + PDF are ONE path (Jim's call): both render the note into a print-only container on the main
 * document and invoke the OS print/share sheet — Save-as-PDF is the user picking it there. The iOS-PWA no-op
 * is surfaced as a VISIBLE fallback message, never swallowed.
 */
export interface ExportPanelProps {
  /** The open note — its title + body are what we serialize / print. */
  note: Note;
  /** Dismiss the panel (NoteRoute clears the `?export` param). */
  onBack: () => void;
}

export function ExportPanel({ note, onBack }: ExportPanelProps) {
  const [busy, setBusy] = useState<null | 'markdown' | 'print'>(null);
  // Set when a print attempt NO-OP'd (the iOS-PWA landmine) — surfaced as a visible fallback, never swallowed.
  const [printBlocked, setPrintBlocked] = useState(false);

  const noteTitle = note.title.trim() || 'Untitled';

  const handleMarkdown = async () => {
    setBusy('markdown');
    try {
      await exportMarkdown(note);
    } catch {
      showToast('Couldn’t export Markdown — try again.');
    } finally {
      setBusy(null);
    }
  };

  const handlePrint = async () => {
    setBusy('print');
    setPrintBlocked(false);
    try {
      const { ok } = await printNote(note);
      // ok:false = the OS print sheet never opened (installed iOS PWA no-op). Make the failure VISIBLE.
      if (!ok) setPrintBlocked(true);
    } catch {
      setPrintBlocked(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="history share">
      <div className="history__header">
        <button className="history__back" onClick={onBack} aria-label="Back to note">
          ←
        </button>
        <h2 className="history__title">Export</h2>
      </div>

      <section className="settings__section" aria-label="Export this note">
        <h2 className="settings__section-title">Export “{noteTitle}”</h2>
        <p className="settings__row-hint">
          Save this note as a Markdown file, or open the print sheet to print it or save it as a PDF.
        </p>

        <div className="settings__row settings__row--btn-group">
          <button
            className="settings__row-action"
            onClick={() => void handleMarkdown()}
            disabled={busy !== null}
            aria-label="Export as Markdown"
          >
            {busy === 'markdown' ? 'Exporting…' : 'Export as Markdown'}
          </button>
        </div>

        <div className="settings__row settings__row--btn-group">
          <button
            className="settings__row-action"
            onClick={() => void handlePrint()}
            disabled={busy !== null}
            aria-label="Export as PDF"
          >
            {busy === 'print' ? 'Opening…' : 'Export as PDF'}
          </button>
          <button
            className="settings__row-action"
            onClick={() => void handlePrint()}
            disabled={busy !== null}
            aria-label="Print"
          >
            Print
          </button>
        </div>
        <p className="settings__row-hint">
          “Export as PDF” and “Print” both open your device’s print sheet — choose <strong>Save to PDF</strong>{' '}
          there to save a PDF.
        </p>

        {printBlocked && (
          <div className="settings__row settings__row--btn-group">
            <p className="settings__error" role="alert">
              Couldn’t open the print sheet. Some installed apps block printing — open{' '}
              <strong>{noteTitle}</strong> in Safari (or your browser) and use its Share → Print, or export as
              Markdown instead.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
