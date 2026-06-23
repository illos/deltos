import { useEffect } from 'react';
import { create } from 'zustand';
import { readSpellcheck, writeSpellcheck } from '../db/spellcheckPointer.js';

/**
 * The spellcheck toggle (#69 §5), device-local + SHARED reactive state — mirrors useCustomKeyboard. A
 * Zustand store so the Settings toggle and the editor adapter react to a flip immediately (turning it off
 * must drop squiggles + unload the engine app-wide). DEFAULT ON: render-before-data starts `true`, then
 * hydrates from deviceState. Consumers that allocate resources (the adapter's worker) should gate on
 * `_loaded` so a user who disabled it never spins the engine up during the brief IDB read.
 */
interface SpellcheckStore {
  enabled: boolean;
  _loaded: boolean;
  init: () => Promise<void>;
  set: (enabled: boolean) => void;
}

export const useSpellcheckStore = create<SpellcheckStore>((set) => ({
  enabled: true,
  _loaded: false,
  async init() {
    const enabled = await readSpellcheck();
    set({ enabled, _loaded: true });
  },
  set(enabled) {
    set({ enabled });
    void writeSpellcheck(enabled);
  },
}));

/** [enabled, setEnabled] over the shared store; hydrates from deviceState until loaded. */
export function useSpellcheck(): [boolean, (enabled: boolean) => void] {
  const enabled = useSpellcheckStore((s) => s.enabled);
  const setEnabled = useSpellcheckStore((s) => s.set);
  useEffect(() => {
    if (!useSpellcheckStore.getState()._loaded) void useSpellcheckStore.getState().init();
  }, []);
  return [enabled, setEnabled];
}
