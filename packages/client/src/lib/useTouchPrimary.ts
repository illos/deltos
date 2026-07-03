import { useEffect, useState } from 'react';

/**
 * Touch-FIRST modality detection for the custom keyboard (Deck) gate — the successor to gating the Deck on
 * `!useIsDesktop()` (pure `(min-width: 769px)`). A half-width laptop window is narrow but still a hardware-
 * keyboard machine; width told us "mobile" and wrongly summoned the Deck. This asks the real question:
 * *is the primary input a finger, with no hardware keyboard in play?* Three composed signals:
 *
 *   1. TOUCH-FIRST BASE — the primary pointer is coarse (finger) AND the device reports touch points. A
 *      laptop window at any width is `pointer: fine` → false. Live-reactive on the media query.
 *   2. FINE-POINTER-ATTACHED YIELD — a touch-first device with ANY fine pointer attached (iPad + Magic
 *      Keyboard / trackpad / mouse) yields the Deck. Live-reactive both ways (attach/detach).
 *   3. HARDWARE-KEYDOWN LATCH — a keyboard-only folio / BT keyboard emits no `any-pointer: fine`, so we
 *      also watch for a TRUSTED keydown that proves physical keys. Once seen, the Deck yields for the rest
 *      of the session (module-level, never un-latched). SCOPED to the Deck-active editor surface: the latch
 *      only trips for keydowns whose target sits inside an `[inputmode="none"]` element. This is required
 *      because iOS's SOFTWARE keyboard ALSO fires trusted keydowns with real `e.key` values — typing in any
 *      normal form input (search, login/TOTP, settings) would otherwise falsely latch and permanently kill
 *      the Deck on a genuine touch-first phone. The ProseMirror contenteditable carries `inputmode: 'none'`
 *      exactly when the Deck is up (ProseMirrorEditor.tsx), which suppresses the OS keyboard there — so a
 *      keydown targeting that surface can ONLY be a physical key. Accepted trade-off: the latch can now
 *      only trip while the Deck is actually active on the editor — which is the only place it matters. The
 *      on-screen Deck drives ProseMirror via `view.dispatch` / commands and dispatches NO DOM events, so it
 *      can never trip this latch itself (verified in deckAdapter.ts); synthetic events are
 *      `isTrusted === false` and are ignored regardless.
 *
 * SSR / no-matchMedia (jsdom) default: TRUE — assume the touch-first environment, the exact parallel to
 * `useIsDesktop`'s "assume mobile" (false) default. Real browsers always have matchMedia, so this branch
 * is a test/SSR-only path and never fires in production.
 */

const COARSE_QUERY = '(pointer: coarse)'; // the PRIMARY pointer is coarse (a finger) → a touch-first device
const ANY_FINE_QUERY = '(any-pointer: fine)'; // ANY fine pointer attached (trackpad / mouse / Magic Keyboard)

// Module-level session latch: set once (never cleared) the first time a TRUSTED KeyboardEvent proves a
// physical keyboard. A tiny subscribe/notify (not per-component state) so EVERY mounted hook instance —
// including ones that mounted before the keydown — re-evaluates when the latch trips.
let hardwareKeyboardSeen = false;
const latchListeners = new Set<() => void>();

/** Does this trusted keydown prove a PHYSICAL keyboard (a key the on-screen Deck can't produce)? */
function keydownProvesHardware(e: KeyboardEvent): boolean {
  if (!e.isTrusted) return false; // synthetic (dispatched) events never latch — the Deck's would be untrusted anyway
  const k = e.key;
  if (
    k === 'Enter' || k === 'Tab' || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown' ||
    k.startsWith('Arrow')
  ) {
    return true;
  }
  // A single printable char with NO modifier held: the Deck routes text through PM commands, never a DOM
  // keydown, so a bare printable keydown is a physical key. (Modifier combos are ambiguous → ignored.)
  return k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (hardwareKeyboardSeen) return;
  // Scope the latch to the Deck-active editor surface: only a keydown targeting an `[inputmode="none"]`
  // element proves physical keys. Everywhere else (normal form inputs) iOS's software keyboard fires
  // trusted keydowns too, so latching there would be a false positive on a real touch-first phone.
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('[inputmode="none"]')) return; // OS-keyboard-capable surface — never latch
  if (!keydownProvesHardware(e)) return;
  hardwareKeyboardSeen = true;
  for (const notify of latchListeners) notify();
}

// The global capture listener is installed exactly once, lazily, on first hook mount in a DOM environment.
let listenerInstalled = false;
function ensureKeydownListener(): void {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('keydown', onGlobalKeydown, { capture: true, passive: true });
}

/** Compute the current touch-first verdict from the latch + the two media queries. */
function computeTouchPrimary(): boolean {
  if (hardwareKeyboardSeen) return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true; // SSR/jsdom default
  const coarsePrimary =
    window.matchMedia(COARSE_QUERY).matches &&
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints ?? 0) > 0;
  if (!coarsePrimary) return false;
  if (window.matchMedia(ANY_FINE_QUERY).matches) return false; // fine pointer attached → yield the Deck
  return true;
}

/**
 * True iff the device is touch-FIRST and no hardware keyboard has been detected this session. Drives the
 * custom-keyboard (Deck) gate ONLY — layout forks stay width-based on {@link useIsDesktop}. SSR-safe;
 * re-evaluates on pointer-capability changes and latches off on the first trusted hardware keydown.
 */
export function useTouchPrimary(): boolean {
  const [touchPrimary, setTouchPrimary] = useState(computeTouchPrimary);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    ensureKeydownListener();
    const update = () => setTouchPrimary(computeTouchPrimary());
    const mqls =
      typeof window.matchMedia === 'function'
        ? [window.matchMedia(COARSE_QUERY), window.matchMedia(ANY_FINE_QUERY)]
        : [];
    for (const mql of mqls) mql.addEventListener('change', update);
    latchListeners.add(update);
    update(); // sync in case anything changed between the initial state and this effect
    return () => {
      for (const mql of mqls) mql.removeEventListener('change', update);
      latchListeners.delete(update);
    };
  }, []);
  return touchPrimary;
}
