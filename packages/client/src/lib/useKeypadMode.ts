import { useCustomKeyboard } from './useCustomKeyboard.js';
import { useTouchPrimary } from './useTouchPrimary.js';
import { useInstalledPwa } from './useInstalledPwa.js';

/**
 * The ONE derived gate for "the editor uses the custom keyboard (Deck keypad) instead of the native one".
 * Composed from three device/preference signals so the two consumers (the editor's `inputmode=none` decision
 * in ProseMirrorEditor and the shell's Deck-suppression on the note route in App) can NEVER diverge:
 *
 *   1. the opt-in SETTING is ON       — {@link useCustomKeyboard} (device-local, default OFF)
 *   2. the device is TOUCH-FIRST      — {@link useTouchPrimary} (finger primary, no hardware keyboard)
 *   3. we're an INSTALLED PWA         — {@link useInstalledPwa} (standalone, not a mobile browser tab)
 *
 * Browser-tab usage (a Safari/Chrome tab, not standalone) always rides the NATIVE keyboard — the keypad and
 * its Settings toggle are installed-PWA-only. Deck PRESENCE is unaffected (that stays touch-first only, in App).
 */
export function useKeypadMode(): boolean {
  const [customKbEnabled] = useCustomKeyboard();
  const touchPrimary = useTouchPrimary();
  const installedPwa = useInstalledPwa();
  return customKbEnabled && touchPrimary && installedPwa;
}
