import { create } from 'zustand';

/**
 * In-flight large-file upload tracker (direct-r2-upload.md §6.3) — the small client store the UPLOAD-FIRST
 * progress UI renders from. Only the DIRECT-to-R2 path (files > DIRECT_R2_THRESHOLD) registers here; small
 * buffered uploads are fast and get no progress UI.
 *
 * UPLOAD-FIRST invariant: an entry is a TRANSIENT indicator, NOT a note. The real file note is minted only on
 * `confirm` success (createFileNote, below the upload call). So a failed/cancelled upload just removes its
 * entry — there is never an orphan note. On cancel the stored `cancel()` aborts the XHR.
 *
 * Lightweight by design (a zustand store of plain rows + a number) so it is safe in the entry bundle, while
 * the heavy hashing/XHR code stays lazy in `blobClient` (FN-8 perf split).
 */
export interface UploadEntry {
  /** Stable id for the in-flight upload (its own, not the eventual note's — no note exists yet). */
  id: string;
  /** The file's name, shown in the progress row. */
  name: string;
  /** Fractional progress, 0..1 (undefined until the first progress event → an indeterminate bar). */
  progress: number;
  /** Abort the upload (aborts the XHR). Wired to the row's Cancel control. */
  cancel: () => void;
}

interface UploadState {
  uploads: UploadEntry[];
  /** Register a new in-flight upload; returns its id. */
  start(name: string, cancel: () => void): string;
  /** Update an upload's fractional progress (0..1). */
  setProgress(id: string, progress: number): void;
  /** Remove an upload (on success, failure, or cancel — the indicator just disappears). */
  finish(id: string): void;
}

export const useUploadStore = create<UploadState>((set) => ({
  uploads: [],

  start(name, cancel) {
    const id = crypto.randomUUID();
    set((s) => ({ uploads: [...s.uploads, { id, name, progress: 0, cancel }] }));
    return id;
  },

  setProgress(id, progress) {
    set((s) => ({
      uploads: s.uploads.map((u) => (u.id === id ? { ...u, progress } : u)),
    }));
  },

  finish(id) {
    set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
  },
}));
