/**
 * SwipeRow — iOS-Mail-style swipe-right gesture for the note list. Mobile-first.
 * No framer-motion or animation library; driven by Pointer Events imperatively.
 *
 * Geometry (all in px):
 *   SNAP_OPEN  = 60   — minimum drag to snap open
 *   FAR_RIGHT  = 240  — hard-fling threshold → commit delete directly
 *   OPEN_RIGHT = 120  — resting open width (Copy 60px + Delete 60px)
 *
 * State machine:
 *   closed + drag right ≥ SNAP_OPEN  → open-right  (Copy + Delete revealed)
 *   closed + drag right ≥ FAR_RIGHT  → delete fly-off
 *   open   + drag left or short right → close
 *   open   + drag right ≥ FAR_RIGHT  → delete fly-off
 *   any    + drag left (< 0)          → rubber-band back to closed (future Pin seam)
 *
 * Single-open invariant: openId is lifted to the parent (HomeView). Opening one row
 * causes isOpen=false on all others; the useEffect here snaps them back.
 */
import { useRef, useState, useEffect } from 'react';

const SNAP_OPEN = 60;
const FAR_RIGHT = 240;
const OPEN_RIGHT = 120; // 2 × 60px buttons

export interface SwipeRowProps {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  children: React.ReactNode;
}

export function SwipeRow({ isOpen, onOpen, onClose, onDelete, onDuplicate, children }: SwipeRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const foregroundRef = useRef<HTMLDivElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);

  // React state only for the delete animation (one-shot, post-drag)
  const [isDeleting, setIsDeleting] = useState(false);
  const isDeletingRef = useRef(false);

  // All drag tracking in a ref — never triggers re-renders → 60fps during drag
  const drag = useRef<{
    startX: number;
    startY: number;
    pointerId: number;
    locked: boolean; // dominant-axis lock confirmed
    baseDx: number;  // starting dx (0 = closed, OPEN_RIGHT = already open)
    currentDx: number;
  } | null>(null);

  // Stable prop refs so setTimeout/effects always see the latest callbacks
  const onDeleteRef = useRef(onDelete);
  const onCloseRef = useRef(onClose);
  const onOpenRef = useRef(onOpen);
  onDeleteRef.current = onDelete;
  onCloseRef.current = onClose;
  onOpenRef.current = onOpen;

  // ── Imperative helpers ───────────────────────────────────────────────

  const resetButtons = () => {
    if (copyBtnRef.current) {
      copyBtnRef.current.style.width = '';
      copyBtnRef.current.style.opacity = '';
    }
    if (deleteBtnRef.current) deleteBtnRef.current.style.width = '';
  };

  // Drive foreground transform + stretchy-delete button widths imperatively (no React state → 60fps)
  const applyDx = (dx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    fg.style.transform = `translateX(${dx}px)`;

    if (dx > OPEN_RIGHT) {
      // Stretchy delete: Copy shrinks + fades, Delete fills the revealed gutter
      const p = Math.min(1, (dx - OPEN_RIGHT) / (FAR_RIGHT - OPEN_RIGHT));
      const cw = (OPEN_RIGHT / 2) * (1 - p);
      if (copyBtnRef.current) {
        copyBtnRef.current.style.width = `${cw}px`;
        copyBtnRef.current.style.opacity = `${1 - p}`;
      }
      if (deleteBtnRef.current) deleteBtnRef.current.style.width = `${dx - cw}px`;
    } else {
      resetButtons();
    }
  };

  // Snap foreground to a target dx with a CSS ease transition (~320ms)
  const snapTo = (targetDx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    if (targetDx <= 0) resetButtons();
    fg.classList.add('swipe-row__foreground--snapping');
    fg.style.transform = `translateX(${targetDx}px)`;
    const cleanup = () => fg.classList.remove('swipe-row__foreground--snapping');
    fg.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 360); // fallback if transitionend misfires
  };

  // Hard-commit delete: fly foreground off-screen, collapse row, call onDelete
  const commitDelete = () => {
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    const fg = foregroundRef.current;
    if (fg) {
      fg.classList.add('swipe-row__foreground--snapping');
      fg.style.transform = 'translateX(110%)';
    }
    // Collapse the row after fly-off, then call onDelete (soft-delete → removes from list)
    setTimeout(() => {
      setIsDeleting(true);
      setTimeout(() => onDeleteRef.current(), 220);
    }, 260);
  };

  // ── Effects ──────────────────────────────────────────────────────────

  // Snap back to closed when isOpen is externally cleared (another row opened)
  const prevIsOpen = useRef(isOpen);
  useEffect(() => {
    const was = prevIsOpen.current;
    prevIsOpen.current = isOpen;
    if (was && !isOpen) snapTo(0);
  }); // runs every render — cheap, guards on prevIsOpen

  // Close on outside tap when open (capture phase so it beats other handlers)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener('pointerdown', handler, { capture: true });
    return () => document.removeEventListener('pointerdown', handler, { capture: true });
  }, [isOpen]);

  // ── Pointer event handlers ───────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDeletingRef.current) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      locked: false,
      baseDx: isOpen ? OPEN_RIGHT : 0,
      currentDx: isOpen ? OPEN_RIGHT : 0,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;

    const rawDx = e.clientX - d.startX;
    const rawDy = e.clientY - d.startY;

    if (!d.locked) {
      // Wait for 8px movement before committing to an axis
      if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
      // Vertical scroll wins — abandon drag tracking
      if (Math.abs(rawDy) >= Math.abs(rawDx)) { drag.current = null; return; }
      // Horizontal confirmed — lock and capture so we own all future pointer events
      d.locked = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    // Left drag rubber-bands slightly (-30px), right drag is uncapped (stretchy delete continues past FAR_RIGHT)
    const dx = Math.max(-30, d.baseDx + rawDx);
    d.currentDx = dx;
    applyDx(dx);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;

    if (!d.locked) {
      // Plain tap (no drag) — close if open, otherwise let children handle
      if (isOpen) { onCloseRef.current(); snapTo(0); }
      return;
    }

    const dx = d.currentDx;
    if (dx >= FAR_RIGHT) {
      commitDelete();
    } else if (dx >= SNAP_OPEN) {
      snapTo(OPEN_RIGHT);
      onOpenRef.current();
    } else {
      // Short drag or left rubber-band — close
      if (isOpen) onCloseRef.current();
      snapTo(0);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className={`swipe-row${isDeleting ? ' swipe-row--deleting' : ''}`}>
      {/* Back layer: always behind the foreground; buttons revealed as foreground slides right */}
      <div className="swipe-row__back">
        {/* Right-swipe panel: Copy + Delete (positioned at left edge; revealed by right drag) */}
        <div className="swipe-row__back-right">
          <button
            ref={copyBtnRef}
            className="swipe-row__btn swipe-row__btn--copy"
            onClick={(e) => { e.stopPropagation(); onClose(); snapTo(0); onDuplicate(); }}
          >
            Copy
          </button>
          <button
            ref={deleteBtnRef}
            className="swipe-row__btn swipe-row__btn--delete"
            onClick={(e) => { e.stopPropagation(); commitDelete(); }}
          >
            Delete
          </button>
        </div>
        {/* Left-swipe seam: future Pin slot (right edge; left drag reveals — rubber-bands in v1) */}
        <div className="swipe-row__back-left" aria-hidden="true" />
      </div>

      {/* Foreground: the note row content; slides right imperatively over the back layer */}
      <div
        ref={foregroundRef}
        className="swipe-row__foreground"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* When open: intercept taps on the foreground to close rather than navigate */}
        {isOpen && (
          <div className="swipe-row__tap-close" onClick={() => { onClose(); snapTo(0); }} />
        )}
        {children}
      </div>
    </div>
  );
}
