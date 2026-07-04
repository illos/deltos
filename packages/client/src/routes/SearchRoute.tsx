import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchResultsBody } from '../components/SearchResults.js';

// ---------------------------------------------------------------------------
// SearchRoute
// ---------------------------------------------------------------------------

/**
 * Full-screen search surface.
 *
 * Entry: the 🔍 button in the shell header (desktop) or region-3 (ThreeRegionShell). Mobile no longer
 * routes here — it runs search IN PLACE on the note list (HomeView) with a keys-only Deck keypad; this
 * route + its chrome are the DESKTOP surface and stay exactly as they were.
 *
 * Search is fully local/offline — searches the synced Dexie store, no server round-trip. Debounced 200ms
 * before running (the shared {@link SearchResultsBody} runs the fuzzy engine + notebook grouping).
 *
 * Layout: current notebook = flat expanded list; other notebooks = collapsed "Name (N)" accordions.
 * Tapping a result opens the note WITHOUT changing the current notebook pointer (peek).
 */
export function SearchRoute() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Focus the search input synchronously after mount (useLayoutEffect) so the keyboard is
  // raised before the first paint.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 200ms debounce — keeps keystroke rendering snappy even on large local sets.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const handleClear = useCallback(() => {
    setQuery('');
    inputRef.current?.focus();
  }, []);

  return (
    <div className="search">
      <div className="search__bar">
        <button
          className="search__back"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          ←
        </button>
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          inputMode="search"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Search notes"
        />
        {query && (
          <button
            className="search__clear"
            aria-label="Clear search"
            onClick={handleClear}
          >
            ✕
          </button>
        )}
      </div>

      <SearchResultsBody debouncedQuery={debouncedQuery} />
    </div>
  );
}
