import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';
import { useNotes, useNotebooks } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import { searchNotes } from '../lib/search.js';
import type { NoteSearchResult, MatchRange } from '../lib/search.js';
import { formatSmartDate } from '../lib/notePreview.js';
import type { NotebookRow } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Highlight rendering
// ---------------------------------------------------------------------------

function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const nodes: React.ReactNode[] = [];
  let cur = 0;
  for (const { start, end } of ranges) {
    if (start > cur) nodes.push(text.slice(cur, start));
    nodes.push(<mark key={start} className="search__mark">{text.slice(start, end)}</mark>);
    cur = end;
  }
  if (cur < text.length) nodes.push(text.slice(cur));
  return <>{nodes}</>;
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

interface ResultRowProps {
  result: NoteSearchResult;
}

function ResultRow({ result }: ResultRowProps) {
  const { note, snippet, snippetRanges, titleRanges } = result;
  const displayTitle = note.title || 'Untitled';
  const date = formatSmartDate(note.updatedAt);

  return (
    <li className="search__row">
      <Link to={`/note/${note.id}`} className="search__row-link">
        <span className="search__row-title">
          <Highlight text={displayTitle} ranges={titleRanges} />
        </span>
        <span className="search__row-meta">
          {snippet && (
            <span className="search__row-snippet">
              <Highlight text={snippet} ranges={snippetRanges} />
            </span>
          )}
          <span className="search__row-date">{date}</span>
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Notebook section (accordion for non-current notebooks)
// ---------------------------------------------------------------------------

interface NotebookSectionProps {
  notebook: NotebookRow;
  results: NoteSearchResult[];
  isCurrentNotebook: boolean;
}

function NotebookSection({ notebook, results, isCurrentNotebook }: NotebookSectionProps) {
  const [expanded, setExpanded] = useState(false);

  if (isCurrentNotebook) {
    return (
      <section className="search__section">
        <h2 className="search__section-label">In {notebook.name}</h2>
        <ul className="search__list">
          {results.map((r) => <ResultRow key={r.note.id} result={r} />)}
        </ul>
      </section>
    );
  }

  return (
    <section className="search__section">
      <button
        className="search__nb-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="search__nb-name">{notebook.name} ({results.length})</span>
        <span className="search__nb-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <ul className="search__list">
          {results.map((r) => <ResultRow key={r.note.id} result={r} />)}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main SearchRoute
// ---------------------------------------------------------------------------

interface NotebookGroup {
  notebook: NotebookRow;
  results: NoteSearchResult[];
  isCurrentNotebook: boolean;
  /** Best score in the group — used to sort non-current groups by relevance. */
  topScore: number;
}

/**
 * Full-screen search surface.
 *
 * Entry: BottomNav 'search' slot (mobile) or the 🔍 button in the shell header (desktop).
 * Search is fully local/offline — searches the synced Dexie store, no server round-trip.
 * Debounced 200ms before running; results capped at 50 total.
 *
 * Layout: current notebook = flat expanded list; other notebooks = collapsed "Name (N)" accordions.
 * Tapping a result opens the note WITHOUT changing the current notebook pointer (peek).
 */
export function SearchRoute() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const allNotes = useNotes();
  const notebooks = useNotebooks();
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);

  // Focus the search input synchronously after mount (useLayoutEffect) so the keyboard is
  // raised before the first paint. On iOS the BottomNav keyboard anchor has already raised
  // the keyboard; this call transfers focus from anchor to the real input.
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

  // Run search (memoised — only re-runs when notes or debounced query change).
  const results = useMemo(
    () => searchNotes(allNotes, debouncedQuery),
    [allNotes, debouncedQuery],
  );

  // Group results by notebook, current notebook first, others sorted by top score.
  const groups = useMemo((): NotebookGroup[] => {
    if (!results.length) return [];

    const byNotebook = new Map<NotebookId, NoteSearchResult[]>();
    for (const r of results) {
      const id = r.note.notebookId;
      const arr = byNotebook.get(id) ?? [];
      arr.push(r);
      byNotebook.set(id, arr);
    }

    const nbMap = new Map(notebooks.map((nb) => [nb.id, nb]));
    const all: NotebookGroup[] = [];

    for (const [nbId, nbResults] of byNotebook) {
      const notebook = nbMap.get(nbId);
      if (!notebook) continue;
      all.push({
        notebook,
        results: nbResults,
        isCurrentNotebook: nbId === currentNotebookId,
        topScore: nbResults[0]?.score ?? 0,
      });
    }

    // Current notebook first, then others by descending top score.
    all.sort((a, b) => {
      if (a.isCurrentNotebook) return -1;
      if (b.isCurrentNotebook) return 1;
      return b.topScore - a.topScore;
    });

    return all;
  }, [results, notebooks, currentNotebookId]);

  const showEmpty = debouncedQuery && results.length === 0;
  const showHint = !debouncedQuery;

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

      <div className="search__body" role="region" aria-label="Search results" aria-live="polite">
        {showHint && (
          <p className="search__lede">Start typing to search…</p>
        )}
        {showEmpty && (
          <p className="search__lede">No results for &ldquo;{debouncedQuery}&rdquo;</p>
        )}
        {groups.map((g) => (
          <NotebookSection
            key={g.notebook.id}
            notebook={g.notebook}
            results={g.results}
            isCurrentNotebook={g.isCurrentNotebook}
          />
        ))}
      </div>
    </div>
  );
}
