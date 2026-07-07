import type { Note } from '@deltos/shared';
import { ShareLinkSection } from './ShareLinkSection.js';
import { ExportSection } from './ExportSection.js';

/**
 * ShareExportPanel — the combined note "Share" screen (ROAD-0011 P2 + ROAD-0017). Opened from the note action
 * surface via the single `?share` URL param, it renders the full-screen overlay shell (`.history` container +
 * sticky header, mirroring HistoryPanel / InfoPanel) ONCE, then composes the two note-action bodies in order:
 *   1. ShareLinkSection — read-only share links (mint / copy / revoke / re-mint), account-isolated local urls.
 *   2. ExportSection    — Export as Markdown / PDF / Print.
 *
 * Merges what were the two adjacent SharesPanel + ExportPanel surfaces into one screen (one trigger, one
 * chunk). Export is now reachable on mobile too, via this one Share screen.
 *
 * RESIDENCY (lazy off-track surface — CONV-0004 / plugins-lazy-past-first-paint): NoteRoute `lazy()`-loads
 * this as its OWN chunk on the `?share` param, so neither this panel, its `shareApi` client, nor the export
 * serializers / print machinery ever enter the mobile first-load bundle or the editor first-load path.
 */
export interface ShareExportPanelProps {
  /** The open note — its note/notebook are the share targets; its title + body are what export serializes. */
  note: Note;
  /** Dismiss the panel (NoteRoute clears the `?share` param). */
  onBack: () => void;
}

export function ShareExportPanel({ note, onBack }: ShareExportPanelProps) {
  return (
    <div className="history share">
      <div className="history__header">
        <button className="history__back" onClick={onBack} aria-label="Back to note">
          ←
        </button>
        <h2 className="history__title">Share</h2>
      </div>

      <ShareLinkSection note={note} />
      <ExportSection note={note} />
    </div>
  );
}
