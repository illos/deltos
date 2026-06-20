import { create } from 'zustand';
import type { NotebookId } from '@deltos/shared';
import { loadCurrentNotebookId, writeCurrentNotebookId, deleteCurrentNotebookId } from '../db/notebookPointer.js';

interface NotebookState {
  /** False until init() has resolved — the shell spins while this is false. */
  _ready: boolean;
  /** The device-local current notebook. Null = no notebook selected (show the picker). */
  currentNotebookId: NotebookId | null;
  /** Called once by AuthedShell on mount. Reads IDB (with localStorage migration). */
  init(): Promise<void>;
  /** Persist a new current notebook to IDB and update in-memory state. null = select All Notes (clears IDB pointer). */
  setCurrentNotebook(id: NotebookId | null): Promise<void>;
  /**
   * Reset the in-memory store to its pre-init state (#57). Called on an account-change wipe so a
   * logout→login shows NO stale prior-account notebook for the ~1 tick before AuthedShell re-runs
   * init() — the durable Dexie/pointer wipe is already correct; this clears the in-memory mirror.
   */
  reset(): void;
}

export const useNotebookStore = create<NotebookState>((set) => ({
  _ready: false,
  currentNotebookId: null,

  async init() {
    const id = await loadCurrentNotebookId();
    set({ _ready: true, currentNotebookId: id });
  },

  async setCurrentNotebook(id: NotebookId | null) {
    if (id === null) {
      await deleteCurrentNotebookId();
    } else {
      await writeCurrentNotebookId(id);
    }
    set({ currentNotebookId: id });
  },

  reset() {
    set({ _ready: false, currentNotebookId: null });
  },
}));
