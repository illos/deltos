import { useEffect, useState } from 'react';

// The lazy chunk's module type. `typeof import()` is erased at build, so it does NOT pull the dnd-kit-heavy
// impl into this (entry-shell) chunk — the runtime import() below is what code-splits it. Mirrors useNoteDnd.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type CustomReorderModule = typeof import('./customReorderImpl.js');

/**
 * PERF GATE (ROAD-0019): lazily load the library-based custom-reorder chunk. This hook lives in the entry
 * bundle but DYNAMICALLY imports ./customReorderImpl — which statically imports every @dnd-kit/* package —
 * so that ~37 kB gzip code-splits OUT of the entry/editor bundle. It's fetched ONLY when `enabled` (a surface
 * rendering in 'custom' sort). Returns the module once loaded, else null → callers render plain, non-draggable
 * rows until it resolves (a frame or two after the list mounts). ONE loader shared by HomeView + Board.
 */
export function useCustomReorder(enabled: boolean): CustomReorderModule | null {
  const [mod, setMod] = useState<CustomReorderModule | null>(null);
  useEffect(() => {
    if (!enabled || mod) return;
    let alive = true;
    void import('./customReorderImpl.js').then((m) => { if (alive) setMod(m); });
    return () => { alive = false; };
  }, [enabled, mod]);
  return mod;
}
