import { useEffect, useState } from 'react';

// The lazy chunk's module type. `typeof import()` is the idiomatic way to type a dynamically-imported module
// (it's erased at build, so it does NOT pull noteDnd into this chunk — the runtime import() below is what
// code-splits it). The eslint rule that prefers static type-imports doesn't apply to a dynamic-import type.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type NoteDndModule = typeof import('./noteDnd.js');

/**
 * Lazily load the desktop note→notebook DnD chunk (#79). This hook lives in the entry/shell bundle but
 * DYNAMICALLY imports ./noteDnd, so that module code-splits out — it's only fetched when `enabled` (desktop)
 * and never ships in the entry/editor bundle or to mobile. Returns the module once loaded, else null (so
 * callers render rows non-draggable/non-droppable until it's ready — a frame or two after the list mounts).
 */
export function useNoteDnd(enabled: boolean): NoteDndModule | null {
  const [mod, setMod] = useState<NoteDndModule | null>(null);
  useEffect(() => {
    if (!enabled || mod) return;
    let alive = true;
    void import('./noteDnd.js').then((m) => { if (alive) setMod(m); });
    return () => { alive = false; };
  }, [enabled, mod]);
  return mod;
}
