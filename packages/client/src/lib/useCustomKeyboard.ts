import { useEffect } from 'react';
import { create } from 'zustand';
import { readCustomKeyboard, writeCustomKeyboard } from '../db/kbPointer.js';

/**
 * The custom-keyboard opt-in (#69), device-local + SHARED reactive state. A Zustand store (not
 * per-component useState) so every consumer — the Settings toggle, the app shell's nav-kill, and the
 * editor — reacts to a flip immediately (the nav must disappear/return app-wide the instant the toggle
 * changes, and they're not all co-mounted). Render-before-data: starts OFF, swaps to the persisted value
 * once IDB resolves. DEFAULT OFF — Phase 1 has no number layer, so it's strictly opt-in.
 */
interface CustomKeyboardStore {
  enabled: boolean;
  _loaded: boolean;
  init: () => Promise<void>;
  set: (enabled: boolean) => void;
}

export const useCustomKeyboardStore = create<CustomKeyboardStore>((set) => ({
  enabled: false,
  _loaded: false,
  async init() {
    const enabled = await readCustomKeyboard();
    set({ enabled, _loaded: true });
  },
  set(enabled) {
    set({ enabled });
    void writeCustomKeyboard(enabled);
  },
}));

/** [enabled, setEnabled] over the shared store; hydrates from deviceState until loaded. */
export function useCustomKeyboard(): [boolean, (enabled: boolean) => void] {
  const enabled = useCustomKeyboardStore((s) => s.enabled);
  const setEnabled = useCustomKeyboardStore((s) => s.set);
  useEffect(() => {
    if (!useCustomKeyboardStore.getState()._loaded) void useCustomKeyboardStore.getState().init();
  }, []);
  return [enabled, setEnabled];
}
