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
import { lockBodyScroll, unlockBodyScroll } from '../lib/bodyScrollLock.js';

/**
 * NavSheet — the drag-up bottom sheet that IS the app's mobile navigation (ROAD-0011, Jim's ruling).
 * Its content is {@link NavContent}, the single composable nav component the desktop DrawerNav also
 * renders — one source of truth; this is just another CONTAINER, not a forked copy.
 *
 * Entrance: a drag UP starting on the Deck's bottom nav zone (or the Deck-core grabber) while the Deck
 * rides the bottom on mobile. (The top-bar "…" button no longer opens nav — it's been repurposed as the
 * contextual notebook/note options surface, {@link ContextMenuSheet}.)
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
 * {@link NavSheet} renders) and the DeckHostProvider (where the arm zone lives) so the single drag
 * controller drives one sheet from either grab point. The provider is gated `enabled` to mobile whenever the
 * Deck rides the BOTTOM — browsing (nav loadout) AND the editor (keypad mode) — and is OFF on desktop (no
 * Deck) and in native-keyboard editing (body.deck-top: the Deck is a TOP bar there, so a drag-UP is
 * nonsense → gesture inert; see App.tsx `navSheetEnabled`). The panel + backdrop are ALWAYS mounted (parked
 * off-screen via translateY(100%)) so the arming drag has something to follow from the very first pixel;
 * `inert` + aria-hidden when closed keep them out of the a11y/tab tree.
 *
 * FEEL (Jim feel-pass): (1) the page is FROZEN while the sheet moves or is open — {@link lockBodyScroll}
 * (the app's iOS-safe position:fixed scroll lock, reference-counted, restores scrollY on release), engaged
 * from the drag's first confirmed pixel and released when it settles closed; (2) content taps are GATED
 * while the sheet is dragging (and for the one trailing click after it settles open) so a release over a
 * row — the sheet just slid up under the finger — never activates that row. The grabber stays draggable
 * throughout.
 */

const SPRING = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.25, 1)';
const VELOCITY_THRESHOLD = 0.4; // px/ms — a flick past this decides direction regardless of position
// After the sheet settles OPEN, swallow one trailing click for this long — the pointer-up that decided the
// open synthesizes a click on whatever row now sits under the finger; this beat eats it, then taps work.
const CLICK_LATCH_MS = 350;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type DragHandlers = ReturnType<typeof useDragAxis>;

interface NavSheetHandle {
  open: boolean;
  /** True while a confirmed drag is following the finger (not yet settled) — drives the content tap-gate. */
  dragging: boolean;
  /** Pointer handlers shared by the arm zone (Deck nav) AND the sheet grabber — one controller, two grabs. */
  dragHandlers: DragHandlers;
  panelRef: React.RefObject<HTMLDivElement | null>;
  backdropRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  close: () => void;
  /**
   * Called from the content's capture-phase click handler: returns true (and the caller swallows the click)
   * while the sheet is dragging OR for the single trailing click right after it settles open. Consumes the
   * one-shot settle latch, so the NEXT click lands normally.
   */
  shouldSwallowClick: () => boolean;
}

const NavSheetCtx = createContext<NavSheetHandle | null>(null);

/**
 * The Deck (nav loadout AND the core grabber affordance) reaches the arm handlers through this hook.
 * Returns an EMPTY handler set when there is no enabled provider (desktop shell / native-keyboard deck-top)
 * so callers can always spread `{...arm}` without guarding — no provider means no arming, gesture inert.
 * DeckHost also uses the emptiness of this set to decide whether to render the Deck's grabber bar.
 */
const EMPTY_HANDLERS = {} as Partial<DragHandlers>;
export function useNavSheetArm(): Partial<DragHandlers> {
  return useContext(NavSheetCtx)?.dragHandlers ?? EMPTY_HANDLERS;
}

function useNavSheetController(): NavSheetHandle {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;
  // Mirror of `dragging` readable synchronously in the click-capture handler (state lags a render).
  const draggingRef = useRef(false);

  // ── Page freeze (task 1) — the app's iOS-safe, reference-counted scroll lock. Held from the drag's first
  // confirmed pixel through to a settle-closed; idempotent guard so this controller contributes exactly one
  // ref-count no matter how many times ensure/release are called. ──────────────────────────────────────
  const scrollLockedRef = useRef(false);
  const ensureLock = useCallback(() => {
    if (scrollLockedRef.current) return;
    scrollLockedRef.current = true;
    lockBodyScroll();
  }, []);
  const releaseLock = useCallback(() => {
    if (!scrollLockedRef.current) return;
    scrollLockedRef.current = false;
    unlockBodyScroll();
  }, []);

  // ── Tap-gate (task 2) — one-shot latch swallowing the trailing click after a settle-open. ────────────
  const settleLatchRef = useRef(false);
  const latchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldSwallowClick = useCallback(() => {
    if (draggingRef.current) return true; // mid-drag: nothing in the content is clickable
    if (settleLatchRef.current) { settleLatchRef.current = false; return true; } // eat the one trailing click
    return false;
  }, []);

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
    // Freeze while open, release once fully closed (task 1).
    if (next) ensureLock(); else releaseLock();
    setOpen(next);
  }, [ensureLock, releaseLock]);

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
      const willDrive = !openRef.current ? dir === -1 : dir === 1;
      if (!willDrive) return false;
      // A confirmed drag: freeze the page from the first pixel (task 1) and gate content taps (task 2) so a
      // mid-open release over a row can't fire it.
      draggingRef.current = true;
      setDragging(true);
      ensureLock();
      return true;
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
      draggingRef.current = false;
      setDragging(false);
      // Arm the trailing-click latch (task 2): the pointer-up that just settled the sheet may synthesize a
      // click on the row now under the finger — swallow that one. Timer backstop clears it if no click comes.
      settleLatchRef.current = true;
      if (latchTimer.current) clearTimeout(latchTimer.current);
      latchTimer.current = setTimeout(() => { settleLatchRef.current = false; }, CLICK_LATCH_MS);
    },
  });

  // Balance the scroll lock + clear the latch timer on unmount (mirrors BottomNav's unlock-on-unmount).
  useEffect(() => () => {
    releaseLock();
    if (latchTimer.current) clearTimeout(latchTimer.current);
  }, [releaseLock]);

  return { open, dragging, dragHandlers, panelRef, backdropRef, scrollRef, close, shouldSwallowClick };
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

  // Escape closes (consistent with the app's other overlays). Hook is unconditional; guarded on open/ctx.
  useEffect(() => {
    if (!ctx || !ctx.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ctx.close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ctx]);

  if (!ctx) return null;
  const { open, dragging, dragHandlers, panelRef, backdropRef, scrollRef, close, shouldSwallowClick } = ctx;

  return (
    <div
      className={`nav-sheet${open ? ' nav-sheet--open' : ''}${dragging ? ' nav-sheet--dragging' : ''}`}
      aria-hidden={!open}
    >
      {/* Interception scrim — a single full-viewport blur+darken layer over ALL content while the sheet is
          open OR mid-drag (CSS gives it pointer-events + backdrop blur in both states); it's the topmost
          interactive layer below the panel, so every tap on the content beneath lands HERE, never on a note
          row. Dismiss fires on CLICK, not pointerdown: closing flips this layer inert, so dismissing on
          pointerdown would drop it BEFORE the synthesized click hit-tests → that click falls through to the
          row underneath and navigates (the exact tap-through Jim hit). Closing on click keeps the layer live
          through the whole down→up→click, so the click always targets the scrim and never reaches content. */}
      <div ref={backdropRef} className="nav-sheet__backdrop" onClick={close} aria-hidden="true" />
      {/* Panel — parked at translateY(100%) via CSS until the first drag drives it. `inert` when closed
          keeps NavContent's controls out of the tab/AT tree. */}
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
        {/* Content tap-gate (task 2): capture-phase swallow of clicks while dragging + the one trailing click
            after settle-open, so a release over a row never activates it. CSS also sets pointer-events:none
            on this region while dragging (belt); this JS latch also catches the post-settle synthetic click. */}
        <div
          ref={scrollRef}
          className="nav-sheet__scroll"
          onClickCapture={(e) => {
            if (shouldSwallowClick()) { e.preventDefault(); e.stopPropagation(); }
          }}
        >
          <NavContent onNavigate={close} />
        </div>
      </div>
    </div>
  );
}
