import { NavContent } from './NavContent.js';

/**
 * Full-screen cold-start fallback: rendered when there is no valid current-notebook pointer
 * (new device or dangling pointer after a sync-delete). Uses the SAME NavContent as the
 * left drawer — one component, two containers.
 */
export function AllNotebooksScreen() {
  return (
    <div className="all-notebooks">
      <NavContent />
    </div>
  );
}
