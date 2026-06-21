/**
 * Desktop note-region placeholder — shown in region 3 of the 3-region shell when no note is selected
 * (at `/`). Static-vibe placeholder for the Pass B frame; the interactive "open most-recent / hint"
 * behavior is a later collaborative phase (the prototype is static).
 */
export function EmptyNoteState() {
  return (
    <div className="empty-note">
      <p className="empty-note__text">Select a note</p>
    </div>
  );
}
