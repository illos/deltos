/**
 * ConflictView — shows both versions of a conflicted note and lets the user resolve.
 *
 * Layout (mobile-first, stacked):
 *   header: "Sync conflict" + subtitle
 *   two version panels: "Your version" | "Server version"
 *   three action buttons: Keep mine / Keep theirs / Keep both
 *
 * Calls resolveConflict from conflictContract (devSys2 implements via src/db/conflict.ts).
 * On resolve, devSys2 clears note.hasConflict and the NoteRoute re-renders to the editor.
 */
import { useState } from 'react';
import type { Note, BlockBody } from '@deltos/shared';
import {
  useNoteVersions,
  resolveConflict,
  type NoteVersion,
  type ConflictResolution,
} from '../lib/conflictContract.js';

interface ConflictViewProps {
  note: Note;
}

/** Extract short plain-text from a block body using the content.segments pattern. */
function bodyPreview(body: BlockBody, maxChars = 220): string {
  const parts: string[] = [];

  function walk(blocks: BlockBody): void {
    for (const block of blocks) {
      const c = block.content as Record<string, unknown> | undefined;
      if (c) {
        if (Array.isArray(c['segments'])) {
          const text = (c['segments'] as { text: string }[])
            .map((s) => s.text)
            .join('');
          if (text.trim()) parts.push(text);
        } else if (typeof c['code'] === 'string' && c['code'].trim()) {
          parts.push(c['code'].slice(0, 80));
        }
      }
      if (block.children?.length) walk(block.children);
      if (parts.join(' ').length >= maxChars) return;
    }
  }

  walk(body);
  const joined = parts.join(' ');
  return joined.length > maxChars ? joined.slice(0, maxChars) + '…' : joined || '(empty)';
}

function VersionPanel({
  label,
  modifier,
  title,
  body,
  timestamp,
}: {
  label: string;
  modifier: string;
  title: string;
  body: BlockBody;
  timestamp?: string;
}) {
  const preview = bodyPreview(body);
  const dateStr = timestamp ? new Date(timestamp).toLocaleString() : undefined;

  return (
    <div className={`conflict__version conflict__version--${modifier}`}>
      <div className="conflict__version-label">{label}</div>
      {title && <div className="conflict__version-title">{title}</div>}
      <div className="conflict__version-body">{preview}</div>
      {dateStr && <div className="conflict__version-date">{dateStr}</div>}
    </div>
  );
}

type ResolveStep = 'idle' | 'resolving' | 'error';

export function ConflictView({ note }: ConflictViewProps) {
  const versions: NoteVersion[] = useNoteVersions(note.id);
  const [step, setStep] = useState<ResolveStep>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleResolve = (resolution: ConflictResolution) => {
    setStep('resolving');
    resolveConflict(note.id, resolution)
      .catch((e: Error) => { setErrorMsg(e.message); setStep('error'); });
  };

  if (step === 'resolving') {
    return (
      <div className="conflict conflict--loading">
        <div className="auth__spinner" aria-label="Resolving…" />
        <p className="auth__subtitle">Resolving conflict…</p>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="conflict conflict--error">
        <p className="auth__error">{errorMsg}</p>
        <button className="auth__btn" onClick={() => setStep('idle')}>Try again</button>
      </div>
    );
  }

  const conflict = versions[0];

  if (!conflict) {
    // hasConflict=true but no version row yet (race during write). Show loading chrome.
    return (
      <div className="conflict conflict--loading">
        <div className="auth__spinner" aria-label="Loading versions…" />
        <p className="auth__subtitle">Loading versions…</p>
      </div>
    );
  }

  return (
    <div className="conflict">
      <div className="conflict__header">
        <span className="conflict__icon" aria-hidden="true">⚡</span>
        <span className="conflict__title">Sync conflict</span>
        <p className="conflict__subtitle">
          Another device edited this note while offline.
          Your local version was kept — choose how to resolve.
        </p>
      </div>

      <div className="conflict__versions">
        <VersionPanel
          label="Your version"
          modifier="mine"
          title={conflict.title}
          body={conflict.body}
          timestamp={conflict.createdAt}
        />
        <VersionPanel
          label="Server version"
          modifier="theirs"
          title={note.title}
          body={note.body}
          timestamp={note.updatedAt}
        />
      </div>

      <div className="conflict__actions">
        <button
          className="auth__btn auth__btn--primary conflict__action"
          onClick={() => handleResolve('keep-mine')}
        >
          Keep mine
        </button>
        <button
          className="auth__btn conflict__action"
          onClick={() => handleResolve('keep-theirs')}
        >
          Keep theirs
        </button>
        <button
          className="auth__btn conflict__action"
          onClick={() => handleResolve('keep-both')}
        >
          Keep both
          <span className="conflict__action-hint"> (retained, no duplicate note)</span>
        </button>
      </div>
    </div>
  );
}
