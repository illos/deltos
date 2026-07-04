import { create } from 'zustand';

/**
 * In-place search mode (mobile). ONE tiny cross-component flag so the Deck's nav-loadout Search slot
 * (DeckNavLoadout) and the note-list surface (HomeView) — which live in different subtrees — agree on
 * whether the list is in search mode, without prop-drilling through the shell.
 *
 * HomeView OWNS the lifecycle: it opens on this flag / its own pill, drives the query + Deck 'search'
 * loadout, and RESETS the flag to false on unmount (peek into a result / any route change) so the mode
 * never strands the Deck in the 'search' context. Desktop never sets this (it uses the /search route).
 */
interface SearchModeState {
  /** True while the note list is in in-place search mode. */
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSearchModeStore = create<SearchModeState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
