import { useState, useMemo } from 'react';
import type { Note } from '@deltos/shared';
import type { NoteVersion } from '../db/schema.js';
import { noteText } from '../lib/textDelta.js';
import { diffText } from '../lib/textDiff.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type CompareMode = 'current' | 'previous';

type View =
  | { tag: 'timeline' }
  | { tag: 'diff'; version: NoteVersion; compareMode: CompareMode }
  | { tag: 'restore-confirm'; version: NoteVersion };

export interface HistoryPanelProps {
  note: Note;
  /** All versions for this note (any order — panel will sort). */
  versions: NoteVersion[];
  onBack: () => void;
  onRestore: (version: NoteVersion) => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reverse-chronological sort by createdAt (newest first). */
function sortNewestFirst(vs: NoteVersion[]): NoteVersion[] {
  return [...vs].sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
}

function relativeTime(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function absoluteTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

function formatDelta(added?: number, removed?: number): string | null {
  if (added === undefined && removed === undefined) return null;
  const parts: string[] = [];
  if ((added ?? 0) > 0) parts.push(`+${added}`);
  if ((removed ?? 0) > 0) parts.push(`−${removed}`);
  return parts.length ? parts.join(' ') : null;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

interface TimelineProps {
  note: Note;
  sorted: NoteVersion[];
  onSelect: (v: NoteVersion) => void;
  onBack: () => void;
}

function Timeline({ note, sorted, onSelect, onBack }: TimelineProps) {
  return (
    <div className="history">
      <div className="history__header">
        <button className="history__back" onClick={onBack} aria-label="Back to note">←</button>
        <h2 className="history__title">Version History</h2>
      </div>
      <p className="history__device-note">
        History is per-device — it does not sync and will not survive clearing browser data or
        switching to a new device. Your live note always syncs normally.
      </p>
      <ul className="history__list" aria-label="Version history">
        <li className="history__row history__row--current" aria-label="Current version">
          <span className="history__row-time">Current</span>
          <span className="history__row-meta">{note.title || '(untitled)'}</span>
        </li>
        {sorted.length === 0 && (
          <li className="history__empty">No earlier versions</li>
        )}
        {sorted.map((v) => {
          const delta = formatDelta(v.charsAdded, v.charsRemoved);
          return (
            <li key={v.id}>
              <button
                className="history__row history__row--btn"
                onClick={() => onSelect(v)}
                title={absoluteTime(v.createdAt)}
              >
                <span className="history__row-time">{relativeTime(v.createdAt)}</span>
                {v.kind === 'conflict' && (
                  <span className="history__row-badge" aria-label="Conflict version">conflict</span>
                )}
                {delta && (
                  <span className="history__row-delta" aria-label={`Change: ${delta}`}>
                    {delta}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Diff view ─────────────────────────────────────────────────────────────────

interface DiffViewProps {
  version: NoteVersion;
  note: Note;
  prevVersion: NoteVersion | null;
  compareMode: CompareMode;
  onModeChange: (m: CompareMode) => void;
  onBackToTimeline: () => void;
  onRequestRestore: () => void;
}

function DiffView({
  version,
  note,
  prevVersion,
  compareMode,
  onModeChange,
  onBackToTimeline,
  onRequestRestore,
}: DiffViewProps) {
  const tokens = useMemo(() => {
    const vText = noteText(version.title, version.body);
    if (compareMode === 'current') {
      const currText = noteText(note.title, note.body);
      return diffText(vText, currText);
    }
    const prevText = prevVersion ? noteText(prevVersion.title, prevVersion.body) : '';
    return diffText(prevText, vText);
  }, [version, note, prevVersion, compareMode]);

  return (
    <div className="history">
      <div className="history__header">
        <button className="history__back" onClick={onBackToTimeline} aria-label="Back to timeline">
          ← Timeline
        </button>
        <div className="history__diff-toggle" role="group" aria-label="Compare against">
          <button
            className={`history__diff-tab${compareMode === 'previous' ? ' history__diff-tab--active' : ''}`}
            onClick={() => onModeChange('previous')}
            aria-pressed={compareMode === 'previous'}
          >
            vs Previous
          </button>
          <button
            className={`history__diff-tab${compareMode === 'current' ? ' history__diff-tab--active' : ''}`}
            onClick={() => onModeChange('current')}
            aria-pressed={compareMode === 'current'}
          >
            vs Current
          </button>
        </div>
      </div>
      <div className="history__diff-meta">
        <span className="history__diff-time" title={absoluteTime(version.createdAt)}>
          {relativeTime(version.createdAt)}
        </span>
        {version.kind === 'conflict' && (
          <span className="history__row-badge">conflict</span>
        )}
        {compareMode === 'previous' && !prevVersion && (
          <span className="history__diff-hint">(oldest version — showing vs empty)</span>
        )}
      </div>
      <div className="history__diff-body" aria-label="Diff view" aria-live="polite">
        {tokens.map((tok, i) => {
          if (tok.op === 'equal')
            return <span key={i}>{tok.text}</span>;
          if (tok.op === 'insert')
            return <mark key={i} className="history__diff-insert">{tok.text}</mark>;
          return <del key={i} className="history__diff-delete">{tok.text}</del>;
        })}
      </div>
      <button className="history__restore-btn" onClick={onRequestRestore}>
        Restore this version
      </button>
    </div>
  );
}

// ── Restore confirm ───────────────────────────────────────────────────────────

interface RestoreConfirmProps {
  version: NoteVersion;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

function RestoreConfirm({ version, onConfirm, onCancel }: RestoreConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch {
      setError('Restore failed. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="history">
      <div className="history__header">
        <button className="history__back" onClick={onCancel} disabled={busy} aria-label="Cancel">
          ←
        </button>
        <h2 className="history__title">Restore version?</h2>
      </div>
      <div className="history__confirm-body">
        <p>
          Your current note will be saved as a history entry before the restore, so nothing is lost.
          The restored content will sync normally.
        </p>
        <p className="history__confirm-version">
          Version from: <strong>{relativeTime(version.createdAt)}</strong>
        </p>
        {error && <p className="history__error">{error}</p>}
        <div className="history__confirm-actions">
          <button
            className="history__action history__action--primary"
            onClick={() => { void handleConfirm(); }}
            disabled={busy}
          >
            {busy ? 'Restoring…' : 'Restore'}
          </button>
          <button className="history__action" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── HistoryPanel (root) ───────────────────────────────────────────────────────

/**
 * Full-screen note history UI. Manages the timeline → diff → restore-confirm step machine.
 * Receives versions as props (NoteRoute owns `useNoteVersions` and passes them in).
 */
export function HistoryPanel({ note, versions, onBack, onRestore }: HistoryPanelProps) {
  const [view, setView] = useState<View>({ tag: 'timeline' });

  const sorted = useMemo(() => sortNewestFirst(versions), [versions]);

  if (view.tag === 'timeline') {
    return (
      <Timeline
        note={note}
        sorted={sorted}
        onBack={onBack}
        onSelect={(v) => setView({ tag: 'diff', version: v, compareMode: 'previous' })}
      />
    );
  }

  if (view.tag === 'diff') {
    const { version, compareMode } = view;
    const selectedIdx = sorted.findIndex((v) => v.id === version.id);
    const prevVersion = selectedIdx >= 0 ? (sorted[selectedIdx + 1] ?? null) : null;

    return (
      <DiffView
        version={version}
        note={note}
        prevVersion={prevVersion}
        compareMode={compareMode}
        onModeChange={(m) => setView({ tag: 'diff', version, compareMode: m })}
        onBackToTimeline={() => setView({ tag: 'timeline' })}
        onRequestRestore={() => setView({ tag: 'restore-confirm', version })}
      />
    );
  }

  // view.tag === 'restore-confirm'
  const { version } = view;
  return (
    <RestoreConfirm
      version={version}
      onConfirm={() => onRestore(version)}
      onCancel={() => setView({ tag: 'diff', version, compareMode: 'previous' })}
    />
  );
}
