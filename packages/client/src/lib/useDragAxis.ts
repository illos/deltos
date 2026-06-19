import { useRef } from 'react';

interface DragState {
  startPrimary: number;
  startSecondary: number;
  pointerId: number;
  locked: boolean;
  base: number;
  current: number;
  prevPos: number;
  prevTime: number;
}

export interface DragAxisOptions {
  axis: 'x' | 'y';
  /** Absolute position at drag start (e.g. 0 = open, OPEN_RIGHT = already open for SwipeRow). */
  getBase: () => number;
  /** Clamp minimum (rubber-band floor, may be negative). */
  min: number;
  /** Clamp maximum (undefined = uncapped). */
  max?: number;
  /** Called every frame with current absolute position. Apply transform here — no re-render. */
  onMove: (pos: number) => void;
  /** Called on pointer-up (or cancel) after a confirmed drag. velocity is px/ms, sign matches axis direction. */
  onSettle: (pos: number, velocity: number) => void;
  /**
   * Called when axis-lock is confirmed. Return false to abandon (e.g. sheet inner-scroll-vs-dismiss).
   * direction: +1 = positive axis (right for X, down for Y), -1 = negative.
   */
  onLockConfirm?: (direction: 1 | -1) => boolean;
  /** Called on pointer-up when drag never locked (plain tap). */
  onTap?: () => void;
}

export function useDragAxis(opts: DragAxisOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const drag = useRef<DragState | null>(null);

  const getPrimary = (e: React.PointerEvent) =>
    optsRef.current.axis === 'x' ? e.clientX : e.clientY;
  const getSecondary = (e: React.PointerEvent) =>
    optsRef.current.axis === 'x' ? e.clientY : e.clientX;

  const onPointerDown = (e: React.PointerEvent) => {
    const base = optsRef.current.getBase();
    drag.current = {
      startPrimary: getPrimary(e),
      startSecondary: getSecondary(e),
      pointerId: e.pointerId,
      locked: false,
      base,
      current: base,
      prevPos: base,
      prevTime: e.timeStamp,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;

    const { min, max, onMove, onLockConfirm } = optsRef.current;
    const rawPrimary = getPrimary(e) - d.startPrimary;
    const rawSecondary = getSecondary(e) - d.startSecondary;

    if (!d.locked) {
      if (Math.abs(rawPrimary) < 8 && Math.abs(rawSecondary) < 8) return;
      if (Math.abs(rawSecondary) >= Math.abs(rawPrimary)) {
        drag.current = null;
        return;
      }
      const direction: 1 | -1 = rawPrimary >= 0 ? 1 : -1;
      if (onLockConfirm && !onLockConfirm(direction)) {
        drag.current = null;
        return;
      }
      d.locked = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    }

    let pos = d.base + rawPrimary;
    if (pos < min) pos = min;
    if (max !== undefined && pos > max) pos = max;

    d.prevPos = d.current;
    d.prevTime = e.timeStamp;
    d.current = pos;
    onMove(pos);
  };

  const settle = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;

    if (!d.locked) {
      optsRef.current.onTap?.();
      return;
    }

    const dt = e.timeStamp - d.prevTime;
    const velocity = dt > 0 ? (d.current - d.prevPos) / dt : 0;
    optsRef.current.onSettle(d.current, velocity);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: settle,
    onPointerCancel: settle,
  };
}
