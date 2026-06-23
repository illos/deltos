import { useNavigate } from 'react-router-dom';
import { ComposeNew, Search } from '../icons/index.js';

/**
 * The Deck's NAVIGATION loadout (#69 slice B) — the lean browsing controls that own the bottom slot
 * when no note is open, absorbed from the retired standalone bottom nav: New note + Search.
 *
 * HOST-SIDE by design: it knows deltos routes + icons, so it lives in the app and is injected into the
 * (app-agnostic) Deck via the 'navigation' context. Deck core gains nothing app-specific — proving the
 * extensibility model: a whole new context + loadout delivered without touching deck/.
 *
 * No iOS keyboard-anchor dance here (unlike the old BottomNav): in custom-keyboard mode the native
 * keyboard is suppressed (inputmode=none), so navigating away can't summon it.
 *
 * Scope (slice B): New + Search only. The full menu (notebook switcher / trash / settings — the old
 * drag-up sheet) is a follow-up; in custom mode it stays unreached, same as before this slice.
 */
export function DeckNavLoadout() {
  const navigate = useNavigate();
  return (
    <div className="deck-nav" role="toolbar" aria-label="Navigation">
      <button
        type="button"
        className="deck-nav__action deck-nav__action--accent"
        aria-label="New note"
        onClick={() => navigate('/new')}
      >
        <ComposeNew size={24} />
        <span className="deck-nav__label">New</span>
      </button>
      <button
        type="button"
        className="deck-nav__action"
        aria-label="Search"
        onClick={() => navigate('/search')}
      >
        <Search size={24} />
        <span className="deck-nav__label">Search</span>
      </button>
    </div>
  );
}
