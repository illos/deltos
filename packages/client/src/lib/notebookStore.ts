import { create } from 'zustand';
import type { NotebookId } from '@deltos/shared';
import { loadCurrentNotebookId, writeCurrentNotebookId } from '../db/notebookPointer.js';

interface NotebookState {
  /** False until init() has resolved — the shell spins while this is false. */
  _ready: boolean;
  /** The device-local current notebook. Null = no notebook selected (show the picker). */
  currentNotebookId: NotebookId | null;
  /** Called once by AuthedShell on mount. Reads IDB (with localStorage migration). */
  init(): Promise<void>;
  /** Persist a new current notebook to IDB and update in-memory state. */
  setCurrentNotebook(id: NotebookId): Promise<void>;
}

export const useNotebookStore = create<NotebookState>((set) => ({
  _ready: false,
  currentNotebookId: null,

  async init() {
    const id = await loadCurrentNotebookId();
    set({ _ready: true, currentNotebookId: id });
  },

  async setCurrentNotebook(id: NotebookId) {
    await writeCurrentNotebookId(id);
    set({ currentNotebookId: id });
  },
}));
