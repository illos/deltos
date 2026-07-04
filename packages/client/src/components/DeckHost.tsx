import { createContext, useContext, useState, useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Deck } from '../deck/index.js';
import type { DeckContext, DeckLoadoutRegistry } from '../deck/index.js';
import { DeckNavLoadout } from './DeckNavLoadout.js';
import { useNavSheetArm } from './NavSheet.js';

/**
 * DeckHost — the deltos-side glue that mounts the (app-agnostic) Deck at the app-shell level and feeds
 * it context + loadouts. This is the HOST's injection mechanism for the extraction boundary (#69 §0.5):
 * the Deck core just takes `context` + `loadouts` props and knows nothing about deltos; everything
 * deltos-specific (the nav loadout, the editor's keypad, the routes) is assembled here and injected.
 *
 * Two loadout SOURCES feed one surface:
 *  - the NAVIGATION loadout (always available) — the browsing controls (New + Search), shown when no
 *    note/field is focused. This is the 'navigation' context: it enters at the HOST level, not from
 *    deriveDeckContext — a PM EditorState always implies a focused field, so "no editor" has no PM
 *    state to derive from. The provider yields 'navigation' as the editor-absent default.
 *  - the EDITOR loadout — published by the active ProseMirrorEditor via `publishEditor` while a note is
 *    open, withdrawn (null) on unmount. TWO shapes by editor mode (context-aware Deck — Jim):
 *      • KEYPAD mode (custom keyboard on, installed PWA): the keypad, under its live selection-derived
 *        context ('text' / 'node:*'). Bottom Deck.
 *      • NATIVE mode (native keyboard, touch-first): the editor TOOLBAR (the MobileEditorBar controls),
 *        under the fixed 'toolbar' context — so while a note is open the top-bar Deck shows the editor's
 *        formatting/undo controls, NOT the site-navigation loadout (nav is browsing-only). Top Deck.
 *    Either way the editor's published context takes precedence over the nav default while it's mounted.
 *
 * Because the Deck lives here (above the route <Routes>), it PERSISTS across route changes: the keypad
 * while editing, the nav loadout while browsing, with no remount/flash as the note pushes over the list.
 */

/** The editor-absent default context — the browsing situation, no field focused. */
export const DECK_NAV_CONTEXT: DeckContext = 'navigation';

/**
 * The context the NATIVE-mode editor publishes for its toolbar loadout. Fixed (not selection-derived):
 * the MobileEditorBar's group toggles + undo/redo are the same regardless of caret position, so one stable
 * context keys the whole toolbar — no need to enumerate per-node contexts. Distinct from 'navigation' so
 * both stay registered and the active context alone selects which renders (the editor's wins while mounted).
 */
export const DECK_TOOLBAR_CONTEXT: DeckContext = 'toolbar';

/** What the active editor publishes to the host while mounted. */
export interface EditorDeckState {
  /** The editor's live, selection-derived context ('text' | 'node:<type>'). */
  context: DeckContext;
  /** The editor's loadout registry fragment (e.g. { text: <Keypad/> }), merged over the nav loadout. */
  loadouts: DeckLoadoutRegistry;
}

export interface DeckHostHandle {
  /**
   * The active editor publishes its live context + loadout registry while mounted; pass null to
   * withdraw (no editor active → the Deck shows the navigation loadout). Stable identity.
   */
  publishEditor(state: EditorDeckState | null): void;
}

const DeckHostCtx = createContext<DeckHostHandle | null>(null);

/**
 * The editor reaches the host via this hook. Returns a NO-OP handle when there is no provider (e.g. the
 * desktop shell mounts no Deck), so a deeply-nested editor can always publish without guarding.
 */
const NOOP_HANDLE: DeckHostHandle = { publishEditor: () => {} };
export function useDeckHost(): DeckHostHandle {
  return useContext(DeckHostCtx) ?? NOOP_HANDLE;
}

interface DeckHostProviderProps {
  /** Render the Deck surface (mobile + custom-keyboard toggle ON). When false, no Deck is mounted. */
  enabled: boolean;
  children: ReactNode;
}

export function DeckHostProvider({ enabled, children }: DeckHostProviderProps) {
  const [editor, setEditor] = useState<EditorDeckState | null>(null);
  const publishEditor = useCallback((state: EditorDeckState | null) => setEditor(state), []);
  const handle = useMemo<DeckHostHandle>(() => ({ publishEditor }), [publishEditor]);

  // Active context: the editor's live context when a note is open, else the navigation default.
  const context = editor ? editor.context : DECK_NAV_CONTEXT;
  // The nav loadout is always registered; the editor's fragment (if any) is merged over it.
  const loadouts = useMemo<DeckLoadoutRegistry>(
    () => ({ [DECK_NAV_CONTEXT]: <DeckNavLoadout />, ...(editor?.loadouts ?? {}) }),
    [editor],
  );

  // Drag-up nav-sheet arm handlers, injected into the Deck's core grabber affordance so it arms in BOTH
  // bottom placements — the nav loadout AND the editor keypad (Jim's daily driver). Empty when the
  // NavSheetProvider is disabled (desktop / native-keyboard deck-top); that emptiness also gates the grabber
  // off, so it never shows in the top-bar placement where a drag-UP is nonsense. Deliberately NOT armed on
  // the keypad surface itself: the keys carry their own vertical gestures (backspace-repeat, long-press-space
  // caret trackpad), so a dedicated grabber ABOVE the keys is the only arm point there — no key interference.
  const armHandlers = useNavSheetArm();
  // The gesture is armed in BOTH bottom placements; emptiness gates it off in deck-top / desktop.
  const bottomArmed = 'onPointerDown' in armHandlers;
  // WHERE the grabber lives depends on the placement (Jim feel-pass — keypad key collision):
  //  • BROWSING (nav loadout, no editor) — the grabber stays IN the Deck's top edge (.deck__grab): the nav
  //    loadout has no keys under it, so nothing to collide with. Unchanged.
  //  • KEYPAD / editor bottom loadout (a note is open → editor.loadouts ride the bottom) — an in-pane
  //    grabber sits right on the top key row, so a thumb reaching for it hits Y/T. There the in-pane grabber
  //    is WITHHELD (so the keypad keeps its exact native geometry — the grabber's ~14px no longer rides
  //    --deck-h) and a free-FLOATING pill above the keyboard carries the same arm handlers instead (below).
  // `editor` (not the live context) is the signal: present ⇒ a note's editor loadout owns the bottom.
  const editorAtBottom = bottomArmed && editor !== null;
  const browsingGrabber = bottomArmed && editor === null;

  return (
    <DeckHostCtx.Provider value={handle}>
      {children}
      {enabled && (
        <>
          <Deck context={context} loadouts={loadouts} grabHandlers={armHandlers} showGrabber={browsingGrabber} />
          {/* Floating drag handle for the KEYPAD placement — a fixed pill anchored to the Deck's top edge
              (via --deck-h) with a clear air gap, carrying the SAME nav-sheet arm handlers. Rendered OUTSIDE
              the fixed Deck (GOTCHA-0002: a floating overlay adds no in-flow layout height — the point) so it
              clears the keys without shifting them. Present ONLY in the keypad/editor bottom placement:
              withheld while browsing (the in-pane grabber handles that) and in deck-top / desktop
              (bottomArmed is false there). It's below the nav-sheet scrim (z), so an open/dragging sheet
              obscures it. */}
          {editorAtBottom && (
            <div className="deck-float-grab" aria-hidden="true" {...armHandlers}>
              <span className="deck-float-grab__bar" />
            </div>
          )}
        </>
      )}
    </DeckHostCtx.Provider>
  );
}
