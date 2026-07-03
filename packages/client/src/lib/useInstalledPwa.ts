import { useEffect, useState } from 'react';

/**
 * Is deltos running as an INSTALLED PWA (standalone), not a mobile browser tab? Gates the custom keyboard
 * (Deck keypad) + its Settings toggle to the installed app only — in a Safari/Chrome tab the editor always
 * rides the native keyboard and the setting isn't offered. (Deck PRESENCE is separate: that stays touch-first
 * gated via {@link useTouchPrimary}; this only governs keypad-vs-native.)
 *
 * Two independent standalone signals, OR'd:
 *   1. `navigator.standalone === true` — iOS Safari's non-standard home-screen-webclip flag. iOS does NOT
 *      report `display-mode: standalone` for webclips, so this is the only iOS signal. (Type-safe access via
 *      a local Navigator augmentation — it's a Safari-only property absent from lib.dom.)
 *   2. `matchMedia('(display-mode: standalone)').matches` — the standard signal: Android WebAPK + every
 *      modern installed PWA. deltos's manifest declares `display: 'standalone'` (vite.config.ts:142), so an
 *      installed instance matches here.
 *
 * Reactive on the media query's `change` event. Android can technically transition display modes at runtime;
 * iOS is static per launch, so the listener is a free no-op there.
 *
 * SSR / no-matchMedia (jsdom) default: TRUE — assume the installed-PWA environment. This is the exact
 * parallel to {@link useTouchPrimary}'s "assume touch-first" (TRUE) jsdom default, and it keeps the existing
 * keypad render-test corpus green (those tests assume keypad mode is reachable). Real browsers always have
 * matchMedia, so this branch is a test/SSR-only path and never fires in production.
 */

const STANDALONE_QUERY = '(display-mode: standalone)';

/** iOS Safari exposes a non-standard `standalone` boolean on navigator (webclip launched to home screen). */
interface SafariNavigator extends Navigator {
  standalone?: boolean;
}

/** Compute the current installed-PWA verdict from the iOS webclip flag + the standard display-mode query. */
function computeInstalledPwa(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true; // SSR/jsdom default
  if ((navigator as SafariNavigator).standalone === true) return true; // iOS home-screen webclip
  return window.matchMedia(STANDALONE_QUERY).matches; // Android WebAPK + all modern installed PWAs
}

/**
 * True iff deltos is running as an installed/standalone PWA (iOS webclip OR `display-mode: standalone`).
 * SSR-safe; re-evaluates on `display-mode` change. Consumed by {@link useKeypadMode} to gate the custom
 * keyboard + its Settings toggle to the installed app only.
 */
export function useInstalledPwa(): boolean {
  const [installed, setInstalled] = useState(computeInstalledPwa);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(STANDALONE_QUERY);
    const update = () => setInstalled(computeInstalledPwa());
    mql.addEventListener('change', update);
    update(); // sync in case anything changed between the initial state and this effect
    return () => mql.removeEventListener('change', update);
  }, []);
  return installed;
}
