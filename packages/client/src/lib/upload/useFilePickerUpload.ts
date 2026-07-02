import { useEffect, useState } from 'react';

// The lazy chunk's module type. `typeof import()` is erased at build (it does NOT pull filePickerUpload
// into this chunk — the runtime import() below is what code-splits it). Mirrors useFileNoteDnd (#79).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type FilePickerUploadModule = typeof import('./filePickerUpload.js');

/**
 * Lazily load the mobile file-picker → file-note chunk (file-notes.md §5.1). This hook lives in the
 * entry/shell bundle but DYNAMICALLY imports ./filePickerUpload, so that module (and the createFileNote
 * upload path it reaches) code-splits out — never in the mobile first-load / entry bundle (gate FN-8).
 * Warmed on mount so the first tap is snappy; returns the module once loaded, else null.
 */
export function useFilePickerUpload(): FilePickerUploadModule | null {
  const [mod, setMod] = useState<FilePickerUploadModule | null>(null);
  useEffect(() => {
    if (mod) return;
    let alive = true;
    void import('./filePickerUpload.js').then((m) => { if (alive) setMod(m); });
    return () => { alive = false; };
  }, [mod]);
  return mod;
}
