import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { NavContent } from '../views/NavContent.js';
import { useDragAxis } from '../lib/useDragAxis.js';

/**
 * NavSheet — a drag-up bottom sheet that reveals the SAME nav pane the top-bar "…" overflow opens
 * (its content is {@link NavContent}, the single composable nav component the DrawerNav / FullScreenNav
 * also render — one source of truth; this is just a fourth CONTAINER, not a forked copy).
 *
 * TWO entrances to the same pane:
 *   - the "…" button in the shell top bar (unchanged — opens FullScreenNav), and
 *   - a drag UP starting on the Deck's bottom nav zone while browsing on mobile (this file).
 *
 * Mechanics (product-grade port of the /probe/nav Model-B feel-test Jim picked): a real finger-follow
 * translate3d drag off the bottom bar, velocity/threshold release → spring open or dismiss, drag-down on
 * the grabber + backdrop tap to dismiss. Built on the repo's own {@link useDragAxis} primitive (the same
 * engine the legacy BottomNav sheet uses) rather than the throwaway probe handlers: it defers pointer
 * capture until a vertical axis-lock past an 8px slop, so the Deck's tap targets (New / Search / Upload)
 * still fire on a tap and only a deliberate vertical drag arms the sheet — it never fights list scrolling
 * (only the fixed bottom-bar zone carries the arm handlers) or a horizontal gesture.
 *
 * Wiring: {@link NavSheetProvider} owns the controller and must wrap BOTH the shell chrome (where
 * {@link NavSheet} renders) and the DeckHostProvider (where the arm zone, DeckNavLoadout, lives) so the
 * single drag controller drives one sheet from either grab point. The provider is gated `enabled` to
 * mobile browsing (off on the note route + desktop → gesture inert there, per spec). The panel + backdrop
 * are ALWAYS mounted (parked off-screen via translateY(100%)) so the arming drag has something to follow
 * from the very first pixel; `inert` + aria-hidden when closed keep them out of the a11y/tab tree.
 */

const SPRING = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.25, 1)';
const VELOCITY_THRESHOLD = 0.4; // px/ms — a flick past this decides direction regardless of position
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type DragHandlers = ReturnType<typeof useDragAxis>;

interface NavSheetHandle {
  open: boolean;
  /** Pointer handlers shared by the arm zone (Deck nav) AND the sheet grabber — one controller, two grabs. */
  dragHandlers: DragHandlers;
  panelRef: React.RefObject<HTMLDivElement | null>;
  backdropRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  close: () => void;
}

const NavSheetCtx = createContext<NavSheetHandle | null>(null);

/**
 * The Deck nav loadout reaches the arm handlers through this hook. Returns an EMPTY handler set when
 * there is no enabled provider (desktop shell / note route) so the loadout can always spread `{...arm}`
 * without guarding — no provider means no arming, gesture inert.
 */
const EMPTY_HANDLERS = {} as Partial<DragHandlers>;
export function useNavSheetArm(): Partial<DragHandlers> {
  return useContext(NavSheetCtx)?.dragHandlers ?? EMPTY_HANDLERS;
}

function useNavSheetController(): NavSheetHandle {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;

  // Sheet travel in px — the reveal distance from fully-open (0) to fully-parked. Measured from the real
  // panel height when laid out; falls back to ~75vh (jsdom has no layout → the fallback keeps tests sane).
  const heightRef = useRef(typeof window !== 'undefined' ? window.innerHeight * 0.75 : 600);
  useEffect(() => {
    const measure = () => {
      const h = panelRef.current?.getBoundingClientRect().height ?? 0;
      heightRef.current = h > 0 ? h : (typeof window !== 'undefined' ? window.innerHeight * 0.75 : 600);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Rest the sheet open/closed with the spring transition. Clears the mid-drag inline transform back to a
  // deterministic translateY(0 | 100%) so no height measurement is needed for the resting positions.
  const settleTo = useCallback((next: boolean) => {
    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = SPRING;
      panel.style.transform = next ? 'translateY(0)' : 'translateY(100%)';
    }
    const bd = backdropRef.current;
    if (bd) {
      bd.style.transition = 'opacity 0.3s ease';
      bd.style.opacity = next ? '1' : '0';
    }
    setOpen(next);
  }, []);

  const close = useCallback(() => settleTo(false), [settleTo]);

  const dragHandlers = useDragAxis({
    axis: 'y',
    // Start position: 0 when open, the full travel (parked) when closed — so an up-drag off the Deck nav
    // reveals and a down-drag off the grabber dismisses, both read from the same live state.
    getBase: () => (openRef.current ? 0 : heightRef.current),
    min: 0,
    max: heightRef.current,
    onLockConfirm: (dir) => {
      // Closed → only a drag UP arms the reveal. Open → only a drag DOWN dismisses. Anything else is ignored
      // (so a stray downward pull on the Deck bar or an upward pull on an open sheet is a no-op, not a jump).
      if (!openRef.current) return dir === -1;
      return dir === 1;
    },
    onMove: (pos) => {
      const panel = panelRef.current;
      if (panel) {
        panel.style.transition = 'none'; // 1:1 finger-follow — no easing mid-drag
        panel.style.transform = `translate3d(0, ${pos}px, 0)`;
      }
      const bd = backdropRef.current;
      if (bd) {
        bd.style.transition = 'none';
        bd.style.opacity = String(clamp(1 - pos / (heightRef.current || 1), 0, 1));
      }
    },
    onSettle: (pos, velocity) => {
      const H = heightRef.current || 1;
      const next =
        Math.abs(velocity) > VELOCITY_THRESHOLD ? velocity < 0 : pos < H * 0.5;
      settleTo(next);
    },
  });

  return { open, dragHandlers, panelRef, backdropRef, scrollRef, close };
}

interface NavSheetProviderProps {
  /** Arm the gesture (mobile browsing only). When false the sheet is inert and the arm hook is a no-op. */
  enabled: boolean;
  children: ReactNode;
}

export function NavSheetProvider({ enabled, children }: NavSheetProviderProps) {
  // Controller hooks run unconditionally (stable order); the context value gates arming so a disabled
  // provider (note route / desktop) yields no arm handlers and NavSheet renders nothing.
  const controller = useNavSheetController();
  return (
    <NavSheetCtx.Provider value={enabled ? controller : null}>{children}</NavSheetCtx.Provider>
  );
}

/**
 * The sheet surface itself — rendered inside the mobile shell chrome. Reads the shared controller from
 * context; renders nothing when the provider is disabled. Backdrop + grabber + the shared NavContent pane.
 */
export function NavSheet() {
  const ctx = useContext(NavSheetCtx);

  // Escape closes (mirrors the "…" FullScreenNav overlay). Hook is unconditional; guarded on open/ctx.
  useEffect(() => {
    if (!ctx || !ctx.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ctx.close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ctx]);

  if (!ctx) return null;
  const { open, dragHandlers, panelRef, backdropRef, scrollRef, close } = ctx;

  return (
    <div className={`nav-sheet${open ? ' nav-sheet--open' : ''}`} aria-hidden={!open}>
      {/* Scrim — fades in with the reveal; tap to dismiss. pointer-events gated by --open so it never
          blocks the list while parked. */}
      <div ref={backdropRef} className="nav-sheet__backdrop" onPointerDown={close} aria-hidden="true" />
      {/* Panel — parked at translateY(100%) via CSS until the first drag drives it. `inert` when closed
          keeps NavContent's controls out of the tab/AT tree exactly like FullScreenNav. */}
      <div
        ref={panelRef}
        className="nav-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        inert={!open}
      >
        {/* Grabber — the dismiss grab point (drag DOWN); the arm grab point is the Deck nav zone. */}
        <div className="nav-sheet__grabber" {...dragHandlers}>
          <span className="nav-sheet__grabber-bar" />
        </div>
        <div ref={scrollRef} className="nav-sheet__scroll">
          <NavContent onNavigate={close} />
        </div>
      </div>
    </div>
  );
}
