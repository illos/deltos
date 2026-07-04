/**
 * PROBE — mobile nav-gesture feel test (throwaway quality, feel-fidelity is the point).
 *
 * Reached by URL ONLY: /probe/nav. NOT in any nav/menu/discoverability surface. It is a LAZY, off-track
 * route — App.tsx `lazy()`-imports it as its own chunk (ProbeNavRoute-[hash].js + .css), so it adds ZERO
 * bytes to the first-load bundle. The whole probe lives under src/probe/; delete that dir + the one route
 * registration in App.tsx to remove it in a single commit.
 *
 * Three nav-gesture models Jim can feel-test side by side on his iPhone (segmented control, one active):
 *   A — long-press → drag → release, fanning an arc of option bubbles up from the press point (PRIORITY).
 *   B — pull-up sheet (grabber → drag → rubber-band sheet, drag-to-dismiss).
 *   C — press-and-slide across 5 zones on the bottom bar (iOS keyboard-flick feel).
 *
 * An always-visible readout logs the last recognised gesture (model / target / press-duration). Model A
 * exposes live tunables (long-press ms, slop px, bubble size); a global haptic toggle drives the Safari
 * 17.4+ <label><input switch> haptic hack (degrades silently where unsupported).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import './probe.css';

type Model = 'A' | 'B' | 'C';

const TARGETS = ['All Notes', 'Notebook A', 'Notebook B', 'Search', 'Settings'] as const;

const DUMMY_ROWS = Array.from({ length: 20 }, (_, i) => ({
  title: `Dummy note ${i + 1}`,
  sub: `scroll me — testing gesture-vs-scroll interference · row ${i + 1}`,
}));

// Fan geometry (Model A). Bubbles fan UPWARD: angles measured from +x, screen-y inverted.
const FAN_RADIUS = 128;
const FAN_ANGLES = [150, 120, 90, 60, 30]; // left → right, all pointing up

function fanCenter(fx: number, fy: number, i: number): { x: number; y: number } {
  const a = (FAN_ANGLES[i] ?? 90) * (Math.PI / 180);
  return { x: fx + FAN_RADIUS * Math.cos(a), y: fy - FAN_RADIUS * Math.sin(a) };
}

// ── Safari 17.4+ haptic hack: toggling a <label><input type=checkbox switch> fires a system haptic. ──
// Built imperatively (setAttribute('switch')) so it sidesteps JSX typing; degrades silently everywhere else.
function useHaptic(enabled: boolean): () => void {
  const ref = useRef<HTMLLabelElement | null>(null);
  useEffect(() => {
    const label = document.createElement('label');
    Object.assign(label.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      opacity: '0',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', ''); // the magic attribute — only Safari 17.4+ honours it (haptic on toggle)
    label.appendChild(input);
    document.body.appendChild(label);
    ref.current = label;
    return () => {
      label.remove();
      ref.current = null;
    };
  }, []);
  return useCallback(() => {
    if (!enabled) return;
    try {
      ref.current?.click(); // toggles the switch → haptic tick on supported devices; no-op otherwise
    } catch {
      /* silently unsupported */
    }
  }, [enabled]);
}

type Readout = { model: Model; target: string | null; ms: number; note: string } | null;

export function ProbeNavRoute() {
  const navigate = useNavigate();
  const [model, setModel] = useState<Model>('A');
  const [readout, setReadout] = useState<Readout>(null);

  // Global haptic toggle (compare with/without).
  const [haptics, setHaptics] = useState(true);
  const tick = useHaptic(haptics);

  // Model-A tunables.
  const [longPressMs, setLongPressMs] = useState(400);
  const [slopPx, setSlopPx] = useState(10);
  const [bubbleSize, setBubbleSize] = useState(56);

  const log = useCallback((model: Model, target: string | null, ms: number, note: string) => {
    setReadout({ model, target, ms, note });
  }, []);

  const select = useCallback(
    (model: Model, target: string, ms: number) => {
      tick();
      log(model, target, ms, 'SELECT');
    },
    [tick, log],
  );

  return (
    <div className="pb-root" onContextMenu={(e) => e.preventDefault()}>
      <div className="pb-top">
        <p className="pb-title">
          nav-gesture probe · /probe/nav{' '}
          <button
            onClick={() => navigate('/')}
            style={{ float: 'right', background: 'none', border: 0, color: '#7b8496', fontSize: 12 }}
          >
            ✕ exit
          </button>
        </p>
        <div className="pb-seg" role="tablist">
          {(['A', 'B', 'C'] as const).map((m) => (
            <button
              key={m}
              className={m === model ? 'is-active' : ''}
              onClick={() => {
                setModel(m);
                setReadout(null);
              }}
            >
              {m === 'A' ? 'A · Long-press fan' : m === 'B' ? 'B · Pull-up sheet' : 'C · Slide bar'}
            </button>
          ))}
        </div>

        <div className="pb-readout">
          {readout ? (
            <>
              <span className="k">model</span> {readout.model} · <span className="k">target</span>{' '}
              {readout.target ?? '—'} · <span className="k">press</span> {readout.ms}ms ·{' '}
              <span className="k">{readout.note}</span>
            </>
          ) : (
            <span className="k">…last gesture result shows here…</span>
          )}
        </div>

        <label className="pb-haptic">
          <input type="checkbox" checked={haptics} onChange={(e) => setHaptics(e.target.checked)} />
          haptic tick (Safari 17.4+ switch hack) — toggle to compare
        </label>

        {model === 'A' && (
          <div className="pb-tunables">
            <Tune label="long-press ms" min={200} max={700} step={10} value={longPressMs} onChange={setLongPressMs} />
            <Tune label="slop px" min={4} max={40} step={1} value={slopPx} onChange={setSlopPx} />
            <Tune label="bubble px" min={40} max={80} step={2} value={bubbleSize} onChange={setBubbleSize} />
          </div>
        )}
      </div>

      {/* Scrollable dummy list — the gesture-vs-scroll interference surface (scrolls normally). */}
      <div className="pb-list">
        {DUMMY_ROWS.map((r) => (
          <div className="pb-row" key={r.title}>
            <div className="pb-row-title">{r.title}</div>
            <div className="pb-row-sub">{r.sub}</div>
          </div>
        ))}
      </div>

      {model === 'A' && (
        <ModelA
          longPressMs={longPressMs}
          slopPx={slopPx}
          bubbleSize={bubbleSize}
          onOpen={tick}
          onSelect={(t, ms) => select('A', t, ms)}
          onCancel={(ms) => log('A', null, ms, 'cancel')}
        />
      )}
      {model === 'B' && (
        <ModelB onOpen={tick} onSelect={(t) => select('B', t, 0)} onDismiss={() => log('B', null, 0, 'dismissed')} />
      )}
      {model === 'C' && <ModelC onSelect={(t, ms) => select('C', t, ms)} onCancel={(ms) => log('C', null, ms, 'cancel')} />}
    </div>
  );
}

function Tune(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="pb-tune">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="v">{props.value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL A — long-press → drag → release fan.
// ─────────────────────────────────────────────────────────────────────────────
function ModelA(props: {
  longPressMs: number;
  slopPx: number;
  bubbleSize: number;
  onOpen: () => void;
  onSelect: (target: string, ms: number) => void;
  onCancel: (ms: number) => void;
}) {
  const { longPressMs, slopPx, bubbleSize, onOpen, onSelect, onCancel } = props;
  const [fan, setFan] = useState<{ x: number; y: number } | null>(null);
  const [hi, setHi] = useState<number | null>(null);

  const timerRef = useRef<number | undefined>(undefined);
  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const fanRef = useRef<{ x: number; y: number } | null>(null);
  const hiRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const cancelledRef = useRef(false);

  const HIT = bubbleSize / 2 + 30; // generous thumb-sized hit slop

  const reset = useCallback(() => {
    window.clearTimeout(timerRef.current);
    firedRef.current = false;
    cancelledRef.current = false;
    startRef.current = null;
    fanRef.current = null;
    hiRef.current = null;
    setFan(null);
    setHi(null);
  }, []);

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      startRef.current = { x: sx, y: sy, t: Date.now() };
      firedRef.current = false;
      cancelledRef.current = false;
      hiRef.current = null;
      setHi(null);
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        // Clamp the fan origin into safe margins so all bubbles stay reachable near screen edges.
        const ox = Math.min(Math.max(sx, 130), window.innerWidth - 130);
        const oy = Math.min(sy, window.innerHeight - 90);
        fanRef.current = { x: ox, y: oy };
        setFan({ x: ox, y: oy });
        onOpen();
      }, longPressMs);
    },
    [longPressMs, onOpen],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current;
      if (!start || cancelledRef.current) return;
      const x = e.clientX;
      const y = e.clientY;
      if (!firedRef.current) {
        // Before fire: >slop movement cancels the long-press.
        if (Math.hypot(x - start.x, y - start.y) > slopPx) {
          cancelledRef.current = true;
          window.clearTimeout(timerRef.current);
        }
        return;
      }
      const origin = fanRef.current;
      if (!origin) return;
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = 0; i < TARGETS.length; i++) {
        const c = fanCenter(origin.x, origin.y, i);
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const picked = best != null && bestD <= HIT ? best : null;
      hiRef.current = picked;
      setHi(picked);
    },
    [slopPx, HIT],
  );

  const onUp = useCallback(() => {
    const start = startRef.current;
    const ms = start ? Date.now() - start.t : 0;
    if (firedRef.current) {
      const idx = hiRef.current;
      if (idx != null) onSelect(TARGETS[idx] as string, ms);
      else onCancel(ms); // released off any bubble (escape)
    }
    // never-fired (tap or slop-cancel) = no-op, no log noise
    reset();
  }, [onSelect, onCancel, reset]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const handlers = {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };

  return (
    <>
      {/* Origin 1: the bottom bar. */}
      <div className="pb-bar pb-gesture" {...handlers}>
        <span className="pb-bar-label">long-press &amp; drag ↑ (bar)</span>
      </div>
      {/* Origin 2: a FAB bottom-right. */}
      <button className={`pb-fab pb-gesture${fan ? ' is-armed' : ''}`} aria-label="nav" {...handlers}>
        ✦
      </button>

      {fan && (
        <div className="pb-fan-overlay">
          <div className="pb-fan-origin" style={{ left: fan.x, top: fan.y }} />
          {TARGETS.map((t, i) => {
            const c = fanCenter(fan.x, fan.y, i);
            return (
              <div
                key={t}
                className={`pb-bubble${hi === i ? ' is-hi' : ''}`}
                style={{ left: c.x, top: c.y, width: bubbleSize, height: bubbleSize }}
              >
                {t}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL B — pull-up sheet (grabber → rubber-band → drag-to-dismiss).
// ─────────────────────────────────────────────────────────────────────────────
function ModelB(props: { onOpen: () => void; onSelect: (target: string) => void; onDismiss: () => void }) {
  const { onOpen, onSelect, onDismiss } = props;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState<number>(0); // px translateY of the sheet (0 = fully open)

  const H = useRef<number>(Math.round(window.innerHeight * 0.72));
  useEffect(() => {
    const onResize = () => {
      H.current = Math.round(window.innerHeight * 0.72);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startY = useRef(0);
  const startOffset = useRef(0);

  const setClosed = useCallback(() => {
    setOpen(false);
    setOffset(H.current);
  }, []);
  const setOpened = useCallback(() => {
    setOpen(true);
    setOffset(0);
    onOpen();
  }, [onOpen]);

  // Ensure a well-defined resting offset when not dragging.
  useEffect(() => {
    if (!dragging) setOffset(open ? 0 : H.current);
  }, [dragging, open]);

  const beginDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      startY.current = e.clientY;
      startOffset.current = open ? 0 : H.current;
      setDragging(true);
    },
    [open],
  );
  const moveDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragging) return;
      const dy = e.clientY - startY.current; // +down / -up
      const next = Math.min(Math.max(startOffset.current + dy, 0), H.current);
      setOffset(next);
    },
    [dragging],
  );
  const endDrag = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    // Snap: opened if past ~40% revealed, else closed. Rubber-band spring via CSS transition.
    if (offset < H.current * 0.6) setOpened();
    else setClosed();
  }, [dragging, offset, setOpened, setClosed]);

  const dragHandlers = {
    onPointerDown: beginDrag,
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  const sheetStyle = {
    transform: `translate3d(0, ${offset}px, 0)`,
    transition: dragging ? 'none' : 'transform 0.34s cubic-bezier(0.2, 0.9, 0.25, 1)',
  } as const;

  return (
    <>
      <div className="pb-bar">
        <span className="pb-bar-label">drag the grabber ↑</span>
      </div>
      {/* Always-visible grabber above the bar — drag up to reveal. */}
      <div className="pb-grabber pb-gesture" {...dragHandlers} />

      {open && (
        <div
          className="pb-backdrop"
          onPointerDown={() => setClosed()}
          style={{ opacity: 1 - offset / H.current }}
        />
      )}

      <div className="pb-sheet" style={sheetStyle}>
        <div className="pb-sheet-handle pb-gesture" {...dragHandlers} />
        <div className="pb-sheet-body">
          <div className="pb-sheet-sect">Jump to</div>
          {TARGETS.map((t) => (
            <div
              className="pb-sheet-item"
              key={t}
              onClick={() => {
                onSelect(t);
                setClosed();
              }}
            >
              {t}
            </div>
          ))}
          <div className="pb-sheet-sect">More (scroll to test scale)</div>
          {Array.from({ length: 20 }, (_, i) => (
            <div
              className="pb-sheet-item"
              key={`more-${i}`}
              onClick={() => {
                onSelect(`More item ${i + 1}`);
                setClosed();
              }}
            >
              More item {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* dismiss log hook: closing via backdrop/drag-down reports a dismiss when nothing was picked */}
      <DismissReporter open={open} onDismiss={onDismiss} />
    </>
  );
}

// Fires onDismiss when the sheet transitions open→closed (probe readout convenience).
function DismissReporter({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) onDismiss();
    wasOpen.current = open;
  }, [open, onDismiss]);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL C — press-and-slide across 5 zones on the bar (instant, no long-press).
// ─────────────────────────────────────────────────────────────────────────────
function ModelC(props: { onSelect: (target: string, ms: number) => void; onCancel: (ms: number) => void }) {
  const { onSelect, onCancel } = props;
  const barRef = useRef<HTMLDivElement | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const hotRef = useRef<number | null>(null);
  const downT = useRef(0);
  const active = useRef(false);

  const zoneFromX = useCallback((clientX: number): number | null => {
    const el = barRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rel = clientX - r.left;
    if (rel < 0 || rel > r.width) return null;
    return Math.min(Math.max(Math.floor((rel / r.width) * TARGETS.length), 0), TARGETS.length - 1);
  }, []);

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      active.current = true;
      downT.current = Date.now();
      const z = zoneFromX(e.clientX); // instant down-state
      hotRef.current = z;
      setHot(z);
    },
    [zoneFromX],
  );
  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!active.current) return;
      const z = zoneFromX(e.clientX);
      hotRef.current = z;
      setHot(z);
    },
    [zoneFromX],
  );
  const onUp = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    const ms = Date.now() - downT.current;
    const z = hotRef.current;
    if (z != null) onSelect(TARGETS[z] as string, ms);
    else onCancel(ms);
    hotRef.current = null;
    setHot(null);
  }, [onSelect, onCancel]);

  return (
    <div
      className="pb-bar pb-gesture"
      ref={barRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {TARGETS.map((t, i) => (
        <div className={`pb-czone${hot === i ? ' is-hot' : ''}`} key={t}>
          {hot === i && <div className="pb-cpop">{t}</div>}
          {t.split(' ')[0]}
        </div>
      ))}
    </div>
  );
}
