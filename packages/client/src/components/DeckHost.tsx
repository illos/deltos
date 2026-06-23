import { createContext, useContext, useState, useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Deck } from '../deck/index.js';
import type { DeckContext, DeckLoadoutRegistry } from '../deck/index.js';
import { DeckNavLoadout } from './DeckNavLoadout.js';

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
 *  - the EDITOR loadout (the keypad) — published by the active ProseMirrorEditor via `publishEditor`
 *    while a note is open, withdrawn (null) on unmount. Its live selection-derived context ('text' /
 *    'node:*') becomes the active context while editing.
 *
 * Because the Deck lives here (above the route <Routes>), it PERSISTS across route changes: the keypad
 * while editing, the nav loadout while browsing, with no remount/flash as the note pushes over the list.
 */

/** The editor-absent default context — the browsing situation, no field focused. */
export const DECK_NAV_CONTEXT: DeckContext = 'navigation';

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

  return (
    <DeckHostCtx.Provider value={handle}>
      {children}
      {enabled && <Deck context={context} loadouts={loadouts} />}
    </DeckHostCtx.Provider>
  );
}
