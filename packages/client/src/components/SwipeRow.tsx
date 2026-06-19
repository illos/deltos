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
import { useDragAxis } from '../lib/useDragAxis.js';

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

  const [isDeleting, setIsDeleting] = useState(false);
  const isDeletingRef = useRef(false);

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

  const applyDx = (dx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    fg.style.transform = `translateX(${dx}px)`;

    if (dx > OPEN_RIGHT) {
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

  const snapTo = (targetDx: number) => {
    const fg = foregroundRef.current;
    if (!fg) return;
    if (targetDx <= 0) resetButtons();
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
      fg.style.transform = 'translateX(110%)';
    }
    setTimeout(() => {
      setIsDeleting(true);
      setTimeout(() => onDeleteRef.current(), 220);
    }, 260);
  };

  // ── Effects ──────────────────────────────────────────────────────────

  const prevIsOpen = useRef(isOpen);
  useEffect(() => {
    const was = prevIsOpen.current;
    prevIsOpen.current = isOpen;
    if (was && !isOpen) snapTo(0);
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
    getBase: () => (isDeletingRef.current ? 0 : isOpen ? OPEN_RIGHT : 0),
    min: -30,
    onMove: (pos) => applyDx(pos),
    onSettle: (pos) => {
      if (pos >= FAR_RIGHT) {
        commitDelete();
      } else if (pos >= SNAP_OPEN) {
        snapTo(OPEN_RIGHT);
        onOpenRef.current();
      } else {
        if (isOpen) onCloseRef.current();
        snapTo(0);
      }
    },
    onTap: () => {
      if (isOpen) { onCloseRef.current(); snapTo(0); }
    },
  });

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className={`swipe-row${isDeleting ? ' swipe-row--deleting' : ''}`}>
      <div className="swipe-row__back">
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
        <div className="swipe-row__back-left" aria-hidden="true" />
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
