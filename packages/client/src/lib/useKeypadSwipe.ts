import { useRef, useEffect } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

/**
 * Keypad show/hide gestures on the note body (#69 §7, #81). Two independent mechanisms:
 *
 *   • useKeypadSwipe — a caret-placing TAP → SHOW the keypad (the PM `focus` event only fires on focus-IN,
 *     so a tap within an already-focused editor wouldn't otherwise re-show it). PASSIVE: reads pointer
 *     coords only, never preventDefaults/captures, so scrolling is untouched.
 *
 *   • useScrollHideKeypad — a FAST UPWARD scroll of the note body → HIDE the keypad (#81). This replaces the
 *     old pointer-flick auto-hide, which was structurally broken: a fast flick IS native scroll, so the
 *     browser fired pointercancel (not pointerup) and the flick was never detected on any scrollable note.
 *     We now drive the hide off the ACTUAL scroll event instead.
 *
 * Both gate their callback on the manual lock at the call site (the host checks !locked).
 */

/** Total movement below this (px) = a TAP (caret placement), not a drag/scroll. */
export const TAP_MOVE_PX = 10;
/** A note-body scroll faster than this (px/ms), in the UPWARD direction (scrollTop increasing), hides the
 *  keypad. ~0.6 ≈ a deliberate fast flick, above an ordinary read-scroll. Exported for on-device tuning. */
export const HIDE_SCROLL_VELOCITY_PX_PER_MS = 0.6;

/**
 * The hide DECISION (pure, unit-testable): a scroll sample hides the keypad iff scrollTop is INCREASING
 * (upward finger flick — content moves up) AND its velocity meets the threshold. Slow scrolls and downward
 * scrolls (deltaTop ≤ 0) never hide.
 */
export function isFastUpwardScroll(
  deltaTop: number,
  deltaTimeMs: number,
  minVelocity = HIDE_SCROLL_VELOCITY_PX_PER_MS,
): boolean {
  return deltaTimeMs > 0 && deltaTop > 0 && deltaTop / deltaTimeMs >= minVelocity;
}

export interface KeypadSwipeOptions {
  /** Only act while the custom keyboard is active (Deck shown); otherwise a no-op. */
  enabled: boolean;
  /** A caret-placing tap occurred → show the keypad (caller gates on lock). */
  onTap: () => void;
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
    const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y);
    if (moved < TAP_MOVE_PX) optsRef.current.onTap(); // caret placement → show (hide is scroll-driven, #81)
  };

  // A scroll the browser took over (or any aborted gesture) → no tap.
  const onPointerCancel = () => { start.current = null; };

  return { onPointerDown, onPointerUp, onPointerCancel };
}

export interface ScrollHideOptions {
  /** Only listen while the custom keyboard is active (mobile Deck). */
  enabled: boolean;
  /** A fast upward note-body scroll occurred → hide the keypad (caller gates on lock). */
  onHide: () => void;
  /** The editor container; the note scroll container is it or one of its ancestors. */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * Hide the keypad on a fast UPWARD scroll of the note body (#81). Listens for scroll in the CAPTURE phase on
 * document (scroll doesn't bubble, but capture reaches us for any descendant), filtered to the note's scroll
 * container (it or an ancestor of the editor), and tracks scrollTop velocity between samples.
 */
export function useScrollHideKeypad({ enabled, onHide, containerRef }: ScrollHideOptions): void {
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;

  useEffect(() => {
    if (!enabled) return;
    let lastTop: number | null = null;
    let lastTime = 0;
    const onScroll = (e: Event) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const container = containerRef.current;
      // Only the note's scroll container (it or an ancestor of the editor) — ignore unrelated scrolls.
      if (!el || !container || !el.contains(container)) return;
      const top = el.scrollTop;
      const now = e.timeStamp || performance.now();
      if (lastTop !== null && isFastUpwardScroll(top - lastTop, now - lastTime)) onHideRef.current();
      lastTop = top;
      lastTime = now;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [enabled, containerRef]);
}
