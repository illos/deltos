import { useEffect, useState } from 'react';

// The lazy chunk's module type. `typeof import()` is the idiomatic way to type a dynamically-imported module
// (erased at build, so it does NOT pull fileNoteDnd into this chunk — the runtime import() below is what
// code-splits it). Mirrors useNoteDnd (#79).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type FileNoteDndModule = typeof import('./fileNoteDnd.js');

/**
 * Lazily load the desktop list-drop → file-note chunk (file-notes.md §5.1). This hook lives in the
 * entry/shell bundle but DYNAMICALLY imports ./fileNoteDnd, so that module (and the createFileNote upload
 * path it reaches) code-splits out — fetched only when `enabled` (desktop), never in the entry/editor bundle
 * or to mobile first-load (gate FN-8). Returns the module once loaded, else null (the list renders
 * non-droppable until it's ready — a frame or two after mount).
 */
export function useFileNoteDnd(enabled: boolean): FileNoteDndModule | null {
  const [mod, setMod] = useState<FileNoteDndModule | null>(null);
  useEffect(() => {
    if (!enabled || mod) return;
    let alive = true;
    void import('./fileNoteDnd.js').then((m) => { if (alive) setMod(m); });
    return () => { alive = false; };
  }, [enabled, mod]);
  return mod;
}
