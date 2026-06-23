import { useCallback, useEffect, useState } from 'react';
import { readCustomKeyboard, writeCustomKeyboard } from '../db/kbPointer.js';

/**
 * The custom-keyboard opt-in (#69 Phase 1), device-local. Render-before-data (load-feel): starts at the
 * default OFF, then swaps to the persisted value once IDB resolves — one state swap, no blocking read.
 * The editor and the Settings toggle each read independently; they're never co-mounted (Settings is a
 * separate route from an open note), so a flip persists and the next editor mount picks it up.
 */
export function useCustomKeyboard(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    void readCustomKeyboard().then((v) => { if (live) setEnabled(v); });
    return () => { live = false; };
  }, []);

  const set = useCallback((v: boolean) => {
    setEnabled(v);
    void writeCustomKeyboard(v);
  }, []);

  return [enabled, set];
}
