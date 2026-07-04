/**
 * ResourceScopePicker — the shared resource-picker for agent-token / OAuth-grant scoping (ROAD-0011 P1
 * §1.3, Jim's §7 decision 1). ONE presentational picker, reused by both surfaces:
 *   - Settings "Connect to Claude" manual mint (data from the local Dexie store);
 *   - the SEPARATE OAuth consent surface (data fetched from GET /api/account/pickables).
 *
 * PURE / STORE-FREE by design: it imports NO store, NO Dexie, NO fetch — data arrives as props
 * (`notebooks` + an async `searchNotes(q)`), and the selection leaves as a plain `Resource[]` via
 * `onChange`. That is what lets the OAuth consent bundle reuse it without dragging the app shell in.
 *
 * Picker SHAPE matches collection size (Jim's ruling): three choices —
 *   - Whole workspace (default) — the token sees everything; emits `[]` (server clamps absent ⇒ workspace);
 *   - Pick notebooks — a bounded checkbox LIST;
 *   - Pick notes — a SEARCH-select (the search field IS the picker; matches add as removable chips).
 * Notebook + note selections are BOTH carried whenever the mode is not "workspace" — mixed selections are
 * legal (the emitted `Resource[]` is the combined set). Switching to "Whole workspace" overrides to `[]`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Resource } from '@deltos/shared';
import './ResourceScopePicker.css';

export interface PickerNotebook {
  id: string;
  name: string;
}
export interface PickerNote {
  id: string;
  title: string;
}

type Mode = 'workspace' | 'notebooks' | 'notes';

export interface ResourceScopePickerProps {
  /** The bounded notebook set for the LIST select (already account-scoped by the caller). */
  notebooks: PickerNotebook[];
  /** Server/local note search for the SEARCH select — returns matches for `q` (may be async). */
  searchNotes: (q: string) => Promise<PickerNote[]>;
  /** Emitted whenever the selection changes. `[]` = whole workspace (the default). */
  onChange: (resources: Resource[]) => void;
  disabled?: boolean;
  /** Unique-id prefix so several pickers on one page don't collide on input ids. */
  idPrefix?: string;
}

const UNTITLED = 'Untitled note';

export function ResourceScopePicker({
  notebooks,
  searchNotes,
  onChange,
  disabled = false,
  idPrefix = 'rsp',
}: ResourceScopePickerProps) {
  const [mode, setMode] = useState<Mode>('workspace');
  const [selectedNotebookIds, setSelectedNotebookIds] = useState<string[]>([]);
  // Notes keep their title alongside the id so chips render a name without a second lookup.
  const [selectedNotes, setSelectedNotes] = useState<PickerNote[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerNote[]>([]);
  const [searching, setSearching] = useState(false);

  // Derive the Resource[] from the current selection. Whole-workspace ⇒ [] (absent ⇒ workspace server-side);
  // otherwise the COMBINED notebook + note set (mixed selections are legal).
  const resources = useMemo<Resource[]>(() => {
    if (mode === 'workspace') return [];
    const nb = selectedNotebookIds.map((id) => ({ kind: 'notebook', id }));
    const nt = selectedNotes.map((n) => ({ kind: 'note', id: n.id }));
    return [...nb, ...nt] as Resource[];
  }, [mode, selectedNotebookIds, selectedNotes]);

  // Report upward. Keyed on a stable string so this fires only on an actual selection change.
  const key = resources.map((r) => `${r.kind}:${'id' in r ? r.id : ''}`).join('|');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current(resources);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Debounced note search (200ms). A blank query clears the results.
  useEffect(() => {
    if (mode !== 'notes') return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      void searchNotes(q)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, mode, searchNotes]);

  const toggleNotebook = (id: string) => {
    setSelectedNotebookIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const addNote = (note: PickerNote) => {
    setSelectedNotes((prev) => (prev.some((n) => n.id === note.id) ? prev : [...prev, note]));
  };
  const removeNote = (id: string) => {
    setSelectedNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const selectedNoteIds = new Set(selectedNotes.map((n) => n.id));

  return (
    <div className="resource-picker" aria-label="Resource scope">
      <fieldset className="resource-picker__modes" disabled={disabled}>
        <legend className="resource-picker__legend">What can it access?</legend>
        {(
          [
            ['workspace', 'Whole workspace'],
            ['notebooks', 'Pick notebooks'],
            ['notes', 'Pick notes'],
          ] as [Mode, string][]
        ).map(([value, label]) => (
          <label key={value} className="resource-picker__mode">
            <input
              type="radio"
              name={`${idPrefix}-mode`}
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      {mode === 'notebooks' && (
        <div className="resource-picker__notebooks" role="group" aria-label="Notebooks">
          {notebooks.length === 0 ? (
            <p className="resource-picker__empty">No notebooks yet.</p>
          ) : (
            notebooks.map((nb) => (
              <label key={nb.id} className="resource-picker__nb-row">
                <input
                  type="checkbox"
                  checked={selectedNotebookIds.includes(nb.id)}
                  onChange={() => toggleNotebook(nb.id)}
                  disabled={disabled}
                  aria-label={`Notebook ${nb.name || 'Untitled'}`}
                />
                <span className="resource-picker__nb-name">{nb.name || 'Untitled notebook'}</span>
              </label>
            ))
          )}
        </div>
      )}

      {mode === 'notes' && (
        <div className="resource-picker__notes">
          <input
            className="resource-picker__search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes to add…"
            aria-label="Search notes"
            disabled={disabled}
          />
          {selectedNotes.length > 0 && (
            <ul className="resource-picker__chips" aria-label="Selected notes">
              {selectedNotes.map((n) => (
                <li key={n.id} className="resource-picker__chip">
                  <span className="resource-picker__chip-label">{n.title || UNTITLED}</span>
                  <button
                    type="button"
                    className="resource-picker__chip-remove"
                    onClick={() => removeNote(n.id)}
                    disabled={disabled}
                    aria-label={`Remove ${n.title || UNTITLED}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && (
            <ul className="resource-picker__results" aria-label="Note search results">
              {searching ? (
                <li className="resource-picker__result-empty">Searching…</li>
              ) : results.length === 0 ? (
                <li className="resource-picker__result-empty">No matching notes.</li>
              ) : (
                results
                  .filter((n) => !selectedNoteIds.has(n.id))
                  .map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="resource-picker__result"
                        onClick={() => addNote(n)}
                        disabled={disabled}
                        aria-label={`Add ${n.title || UNTITLED}`}
                      >
                        {n.title || UNTITLED}
                      </button>
                    </li>
                  ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
