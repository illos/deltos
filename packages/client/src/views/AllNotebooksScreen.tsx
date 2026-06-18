import { useCallback } from 'react';
import { newNotebookId } from '../lib/ids.js';
import { useNotebookStore } from '../lib/notebookStore.js';

/**
 * Landing screen when no current notebook is set (new device or dangling pointer).
 *
 * v1: no notebook CRUD exists yet — just creates a default notebook to unblock the user.
 * #18 replaces this with the full notebooks-as-a-real-feature surface (list, create, rename,
 * delete). The component shell + CSS class names are stable; #18 fills in the content.
 *
 * When setCurrentNotebook() resolves, the Zustand store update causes AuthedShell to re-render
 * reactively, switching from this screen to the normal shell — no navigation needed here.
 */
export function AllNotebooksScreen() {
  const setCurrentNotebook = useNotebookStore((s) => s.setCurrentNotebook);

  const handleStart = useCallback(() => {
    void setCurrentNotebook(newNotebookId());
  }, [setCurrentNotebook]);

  return (
    <div className="all-notebooks">
      <p className="all-notebooks__lede">No notebook selected.</p>
      <button className="all-notebooks__start" onClick={handleStart}>
        Get started
      </button>
    </div>
  );
}
