import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * useKeypadSwipe (#69 §7) — the keypad show/hide gesture PAIR on the note body, as a single PASSIVE pointer
 * handler:
 *   • a caret-placing TAP (little movement) → SHOW the keypad (pairs with a manual/swipe hide so tapping
 *     back into the note reliably brings it back — the PM `focus` event only fires on focus-IN, missing
 *     caret moves within an already-focused editor);
 *   • a FAST + LARGE upward FLICK → HIDE the keypad (the deferred auto-hide).
 *
 * PASSIVE by design: it only READS pointer coordinates/timing — it never preventDefaults, never captures the
 * pointer — so native note SCROLLING is completely untouched. (A scroll that the browser takes over emits
 * pointercancel, which we treat as "no gesture".) The caller gates both callbacks on the manual lock state.
 *
 * Thresholds are exported for on-device feel-tuning (Jim's gate); they're the long-tail of distinguishing a
 * deliberate hide-flick from an ordinary scroll.
 */

/** Total movement below this (px) = a TAP (caret placement), not a drag/scroll. */
export const TAP_MOVE_PX = 10;
/** A hide-flick must travel at least this far upward (px) — the "LARGE" half. */
export const SWIPE_MIN_DISTANCE_PX = 70;
/** …and at least this average speed (px/ms) — the "FAST" half (≈70px in <120ms). */
export const SWIPE_MIN_VELOCITY_PX_PER_MS = 0.6;

export interface KeypadSwipeOptions {
  /** Only act while the custom keyboard is active (Deck shown); otherwise a no-op. */
  enabled: boolean;
  /** A caret-placing tap occurred → show the keypad (caller gates on lock). */
  onTap: () => void;
  /** A fast + large upward flick occurred → hide the keypad (caller gates on lock). */
  onSwipeUp: () => void;
}

interface PointerStart {
  x: number;
  y: number;
  t: number;
  id: number;
}

export interface KeypadSwipeHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
}

export function useKeypadSwipe(options: KeypadSwipeOptions): KeypadSwipeHandlers {
  const optsRef = useRef(options);
  optsRef.current = options;
  const start = useRef<PointerStart | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!optsRef.current.enabled) { start.current = null; return; }
    start.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId || !optsRef.current.enabled) return;

    const dx = e.clientX - s.x;
    const up = s.y - e.clientY; // upward travel is positive
    const dt = e.timeStamp - s.t;
    const moved = Math.hypot(dx, up);

    if (moved < TAP_MOVE_PX) {
      optsRef.current.onTap(); // caret placement → show
      return;
    }
    // Fast + large + predominantly-upward flick → hide. (Predominantly vertical so a horizontal drag or a
    // diagonal scroll doesn't count.)
    const fastEnough = dt > 0 && up / dt >= SWIPE_MIN_VELOCITY_PX_PER_MS;
    if (up >= SWIPE_MIN_DISTANCE_PX && up > Math.abs(dx) && fastEnough) {
      optsRef.current.onSwipeUp();
    }
  };

  // A scroll the browser took over (or any aborted gesture) → no show, no hide.
  const onPointerCancel = () => { start.current = null; };

  return { onPointerDown, onPointerUp, onPointerCancel };
}
