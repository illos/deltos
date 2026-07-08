/**
 * SwipeRow — iOS-Mail-style two-sided swipe gesture for the note list. Mobile-first.
 * No framer-motion or animation library; driven by Pointer Events imperatively.
 *
 * Layout (notebook-organization rearrange — Jim's exact spec):
 *   RIGHT swipe → reveals **Copy** (tap, secondary) + a right-**fling** commits **Pin** (toggle).
 *   LEFT  swipe → reveals **Move** (tap, secondary) + a left-**fling**  commits **Delete** (fly-off).
 * Copy stays on the right and Move stays on the left as the resting TAP options; only the FLING actions
 * are the primary commits (right-fling = pin, left-fling = delete). Delete's fly-off moved from the right
 * side to the left; Pin replaced delete as the right fling.
 *
 * Geometry (all in px):
 *   SNAP_OPEN  = 55   — minimum drag (either direction) to snap the side open to its tap button
 *   FAR        = 200  — hard-fling threshold (either direction) → commit the side's fling action
 *   OPEN       = 84   — resting open width of the single tap button (Copy right / Move left)
 *
 * State machine:
 *   closed + drag right ≥ SNAP_OPEN  → open-right (Copy tap revealed)
 *   closed + drag right ≥ FAR        → Pin fling (toggle, snaps closed + toast)
 *   closed + drag left  ≤ -SNAP_OPEN → open-left  (Move tap revealed)
 *   closed + drag left  ≤ -FAR       → Delete fly-off
 *   open   + drag back / short        → close
 *
 * Single-open invariant: openId is lifted to the parent (HomeView). Opening one row
 * causes isOpen=false on all others; the useEffect here snaps them back.
 */
import { useRef, useState, useEffect } from 'react';
import { useDragAxis } from '../lib/useDragAxis.js';

const SNAP_OPEN = 55;
const FAR = 200;
const OPEN = 84; // resting width of the single tap button on each side

export interface SwipeRowProps {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Left-drag Move tap → open the notebook-picker sheet for this row. */
  onMove?: () => void;
  /** Right-fling Pin toggle → flip sys:pinnedAt for this row. */
  onPin?: () => void;
  /** Whether this row is currently pinned (drives the Pin button label pin/unpin). */
  isPinned?: boolean;
  children: React.ReactNode;
}

export function SwipeRow({
  isOpen,
  onOpen,
  onClose,
  onDelete,
  onDuplicate,
  onMove,
  onPin,
  isPinned = false,
  children,
}: SwipeRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const foregroundRef = useRef<HTMLDivElement>(null);

  const [isDeleting, setIsDeleting] = useState(false);
  const isDeletingRef = useRef(false);

  // Stable prop refs so setTimeout/effects always see the latest callbacks
  const onDeleteRef = useRef(onDelete);
  const onCloseRef = useRef(onClose);
  const onOpenRef = useRef(onOpen);
  const onPinRef = useRef(onPin);
  onDeleteRef.current = onDelete;
  onCloseRef.current = onClose;
  onOpenRef.current = onOpen;
  onPinRef.current = onPin;
  // Which side the row is resting open on (drives getBase). Cleared on close.
  const sideRef = useRef<'left' | 'right' | null>(null);

  // ── Imperative helpers ───────────────────────────────────────────────

  const applyDx = (dx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    fg.style.transform = `translateX(${dx}px)`;
  };

  const snapTo = (targetDx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    fg.classList.add('swipe-row__foreground--snapping');
    fg.style.transform = `translateX(${targetDx}px)`;
    const cleanup = () => fg.classList.remove('swipe-row__foreground--snapping');
    fg.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 360);
  };

  const commitDelete = () => {
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    const fg = foregroundRef.current;
    if (fg) {
      fg.classList.add('swipe-row__foreground--snapping');
      // Fly off to the LEFT now that Delete lives on the left side.
      fg.style.transform = 'translateX(-110%)';
    }
    setTimeout(() => {
      setIsDeleting(true);
      setTimeout(() => onDeleteRef.current(), 220);
    }, 260);
  };

  // Pin is a toggle, not a fly-off: snap the row closed and fire the toggle (+ the parent toasts).
  const commitPin = () => {
    onCloseRef.current();
    sideRef.current = null;
    snapTo(0);
    onPinRef.current?.();
  };

  // ── Effects ──────────────────────────────────────────────────────────

  const prevIsOpen = useRef(isOpen);
  useEffect(() => {
    const was = prevIsOpen.current;
    prevIsOpen.current = isOpen;
    if (was && !isOpen) { sideRef.current = null; snapTo(0); }
  });

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener('pointerdown', handler, { capture: true });
    return () => document.removeEventListener('pointerdown', handler, { capture: true });
  }, [isOpen]);

  // ── Drag (useDragAxis — X axis) ───────────────────────────────────────

  const dragHandlers = useDragAxis({
    axis: 'x',
    getBase: () => (isDeletingRef.current ? 0 : isOpen ? (sideRef.current === 'left' ? -OPEN : OPEN) : 0),
    // Left-fling delete needs the drag to travel past -FAR; right-fling pin past +FAR. Cap a touch beyond.
    min: -(FAR + 40),
    max: FAR + 40,
    onMove: (pos) => applyDx(pos),
    onSettle: (pos) => {
      if (pos >= FAR) {
        // RIGHT fling → Pin toggle (only when wired; else just snap open to Copy).
        if (onPin) { commitPin(); return; }
        sideRef.current = 'right';
        snapTo(OPEN);
        onOpenRef.current();
      } else if (pos <= -FAR) {
        // LEFT fling → Delete fly-off.
        commitDelete();
      } else if (pos >= SNAP_OPEN) {
        sideRef.current = 'right'; // open the Copy tap seam (no fling-commit — Copy is a tap)
        snapTo(OPEN);
        onOpenRef.current();
      } else if (onMove && pos <= -SNAP_OPEN) {
        sideRef.current = 'left'; // open the Move tap seam (no fling-commit — Move is a tap)
        snapTo(-OPEN);
        onOpenRef.current();
      } else {
        if (isOpen) onCloseRef.current();
        sideRef.current = null;
        snapTo(0);
      }
    },
    onTap: () => {
      if (isOpen) { onCloseRef.current(); sideRef.current = null; snapTo(0); }
    },
  });

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className={`swipe-row${isDeleting ? ' swipe-row--deleting' : ''}`}>
      <div className="swipe-row__back">
        {/* RIGHT side (revealed by a right-drag): Copy tap. Pin is the right-FLING, not a button. */}
        <div className="swipe-row__back-right">
          <button
            className="swipe-row__btn swipe-row__btn--copy"
            onClick={(e) => { e.stopPropagation(); onClose(); sideRef.current = null; snapTo(0); onDuplicate(); }}
          >
            Copy
          </button>
        </div>
        {/* LEFT side (revealed by a left-drag): Move tap. Delete is the left-FLING, not a button. */}
        {onMove && (
          <div className="swipe-row__back-left">
            <button
              className="swipe-row__btn swipe-row__btn--move"
              onClick={(e) => { e.stopPropagation(); onClose(); sideRef.current = null; snapTo(0); onMove(); }}
            >
              Move
            </button>
          </div>
        )}
      </div>

      <div
        ref={foregroundRef}
        className="swipe-row__foreground"
        {...dragHandlers}
      >
        {isOpen && (
          <div className="swipe-row__tap-close" onClick={() => { onClose(); snapTo(0); }} />
        )}
        {children}
      </div>
    </div>
  );
}
