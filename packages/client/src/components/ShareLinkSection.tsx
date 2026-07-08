import type { Note } from '@deltos/shared';
import { useAuthStore } from '../auth/store.js';
import { ShareTarget } from './ShareTarget.js';

/**
 * ShareLinkSection — the "Share link" body of the combined Share screen (ShareExportPanel). Renders NO
 * overlay shell or header of its own (the parent panel owns those), only the `.settings__section` that
 * CREATES and MANAGES read-only share links for THE OPEN NOTE (ROAD-0011 P2).
 *
 * NOTE-ONLY as of notebook-menu-and-keep-view.md §4: the notebook share target that used to render here has
 * MOVED to the notebook "…" menu (NotebookMenuBody), where it belongs — it was only reachable while a note in
 * that notebook was open, and duplicated across every note. The per-note share stays in the note; the
 * relocation is a pure IA move (the notebook-share feature is complete server-side — no worker/schema change).
 * The reusable one-target component lives in ShareTarget.tsx; both the note screen and the notebook menu mount
 * it, keyed by their respective resource.
 *
 * RESIDENCY (lazy off-track surface — CONV-0004 / plugins-lazy-past-first-paint): this rides the combined
 * ShareExportPanel chunk, which NoteRoute `lazy()`-loads on the `?share` param, so neither this section nor
 * its `shareApi` client ever enters the mobile first-load bundle or the editor first-load path.
 */
export interface ShareLinkSectionProps {
  /** The open note — the note itself is the one share target this section renders. */
  note: Note;
}

export function ShareLinkSection({ note }: ShareLinkSectionProps) {
  // Resident account — the isolation scope for the locally-remembered share urls (db/shareUrls.ts).
  const accountId = useAuthStore((s) => s.accountId);
  const noteTitle = note.title.trim() || 'Untitled';

  return (
    <ShareTarget
      resourceType="note"
      resourceId={note.id}
      heading="Share this note"
      targetLabel={`“${noteTitle}”`}
      accountId={accountId}
    />
  );
}
