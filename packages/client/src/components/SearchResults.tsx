import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';
import { useNotes, useNotebooks } from '../db/storeHooks.js';
import { useNotebookStore } from '../lib/notebookStore.js';
import { searchNotes } from '../lib/search.js';
import type { NoteSearchResult, MatchRange } from '../lib/search.js';
import { formatSmartDate } from '../lib/notePreview.js';
import type { NotebookRow } from '../db/schema.js';

/**
 * Shared search-results rendering — the fuzzy engine wiring (searchNotes) + notebook grouping +
 * result rows / accordion, extracted so BOTH consumers share ONE copy (reuse-discipline):
 *   - the full-screen {@link SearchRoute} (desktop 🔍 + region-3), which wraps this in its own
 *     .search / .search__bar chrome, and
 *   - the mobile in-place search mode on the note list (HomeView), which mounts the SAME body under
 *     the list header while the Deck carries a keys-only keypad.
 *
 * Peek navigation is unchanged: a result row is a <Link to="/note/:id"> — opening a result does NOT
 * touch currentNotebookId (the notebook pointer is device-local, set only by explicit switching).
 */

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

function ResultRow({ result }: { result: NoteSearchResult }) {
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
// Results body — the engine + grouping + the scrollable .search__body region
// ---------------------------------------------------------------------------

interface NotebookGroup {
  notebook: NotebookRow;
  results: NoteSearchResult[];
  isCurrentNotebook: boolean;
  /** Best score in the group — used to sort non-current groups by relevance. */
  topScore: number;
}

interface SearchResultsBodyProps {
  /** The debounced, trimmed query the caller owns (the input + debounce live in the caller). */
  debouncedQuery: string;
  /**
   * Show the "Start typing to search…" lede on an empty query. The full-screen SearchRoute keeps it
   * (the surface is otherwise blank); the in-place list mode suppresses it (the note list is the
   * empty-query state there, so the body only mounts once a query is present).
   */
  showHintWhenEmpty?: boolean;
}

export function SearchResultsBody({ debouncedQuery, showHintWhenEmpty = true }: SearchResultsBodyProps) {
  const allNotes = useNotes();
  const notebooks = useNotebooks();
  const currentNotebookId = useNotebookStore((s) => s.currentNotebookId);

  // Run search (memoised — only re-runs when notes or debounced query change).
  const results = useMemo(
    () => searchNotes(allNotes, debouncedQuery),
    [allNotes, debouncedQuery],
  );

  // Group results by notebook, current notebook first, others sorted by top score.
  const groups = useMemo((): NotebookGroup[] => {
    if (!results.length) return [];

    // Synthetic row for uncategorized notes (notebookId = null = All Notes).
    const allNotesRow: NotebookRow = {
      id: null as unknown as NotebookId,
      name: 'All Notes',
      defaultCollectionView: 'list',
      version: 0,
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      syncSeq: 0,
    };

    const byNotebook = new Map<NotebookId | null, NoteSearchResult[]>();
    for (const r of results) {
      const id = r.note.notebookId;
      const arr = byNotebook.get(id) ?? [];
      arr.push(r);
      byNotebook.set(id, arr);
    }

    const nbMap = new Map(notebooks.map((nb) => [nb.id, nb]));
    const all: NotebookGroup[] = [];

    for (const [nbId, nbResults] of byNotebook) {
      const notebook = nbId === null ? allNotesRow : nbMap.get(nbId);
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
  const showHint = showHintWhenEmpty && !debouncedQuery;

  return (
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
  );
}
