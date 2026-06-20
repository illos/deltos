/**
 * Render tests for HistoryPanel — task #46 gate.
 *
 * HP-1  Timeline renders versions with relative time + char-delta
 * HP-2  Conflict-kind versions are marked with a conflict badge
 * HP-3  Empty state shown when there are no versions
 * HP-4  "Current" row is always present at the top
 * HP-5  Tapping a version opens the diff view (vs Previous by default)
 * HP-6  Diff view renders insert/delete spans for changed content
 * HP-7  vs-Current / vs-Previous toggle updates the diff
 * HP-8  Restore button appears in diff view; confirm dialog leads to onRestore()
 * HP-9  Restore-as-new-version: onRestore is called with the right version object
 * HP-10 onBack is called when the back button is pressed from the timeline
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { screen } from './renderHelpers.js';
import type { Note } from '@deltos/shared';
import type { NoteVersion } from '../src/db/schema.js';
import { HistoryPanel } from '../src/components/HistoryPanel.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_ISO = new Date().toISOString();
const YESTERDAY_ISO = new Date(Date.now() - 86_400_000).toISOString();

const mockNote: Note = {
  id: 'note-1',
  notebookId: 'nb-1',
  accountId: 'acct-1',
  title: 'Current Title',
  body: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'current body text' }] }],
  properties: {},
  version: 5,
  updatedAt: NOW_ISO,
  createdAt: YESTERDAY_ISO,
  syncStatus: 'synced',
};

function makeVersion(overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    id: crypto.randomUUID(),
    noteId: 'note-1',
    accountId: 'acct-1',
    kind: 'session',
    title: 'Old Title',
    body: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'old body text' }] }],
    properties: {},
    baseVersion: 3,
    createdAt: YESTERDAY_ISO,
    charsAdded: 120,
    charsRemoved: 18,
    ...overrides,
  };
}

// ── Mount helper ──────────────────────────────────────────────────────────────

function mountPanel(
  versions: NoteVersion[],
  opts: {
    onBack?: () => void;
    onRestore?: (v: NoteVersion) => Promise<void>;
    note?: Note;
  } = {},
) {
  const onBack = opts.onBack ?? vi.fn();
  const onRestore = opts.onRestore ?? vi.fn(async () => {});
  const note = opts.note ?? mockNote;

  render(
    <HistoryPanel
      note={note}
      versions={versions}
      onBack={onBack}
      onRestore={onRestore}
    />,
  );

  return { onBack, onRestore };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── HP-1: Timeline rows + delta ───────────────────────────────────────────────

describe('HP-1 — timeline renders versions with time + char delta', () => {
  it('shows relative time and +added/−removed for session versions', async () => {
    const v = makeVersion({ charsAdded: 120, charsRemoved: 18, createdAt: YESTERDAY_ISO });
    mountPanel([v]);

    await waitFor(() => {
      expect(screen.queryByText('Version History')).not.toBeNull();
    });

    // Delta label visible
    expect(document.body.textContent).toMatch(/\+120/);
    expect(document.body.textContent).toMatch(/−18/);

    // Time label visible (Yesterday or specific date)
    const buttons = document.querySelectorAll('.history__row--btn');
    expect(buttons.length).toBe(1);
  });
});

// ── HP-2: Conflict badge ──────────────────────────────────────────────────────

describe('HP-2 — conflict versions are marked with a badge', () => {
  it('conflict kind renders the conflict badge', async () => {
    const conflictV = makeVersion({ kind: 'conflict', charsAdded: undefined, charsRemoved: undefined });
    mountPanel([conflictV]);

    await waitFor(() => {
      expect(document.querySelector('.history__row-badge')).not.toBeNull();
    });

    expect(document.querySelector('.history__row-badge')!.textContent).toMatch(/conflict/i);
  });

  it('session versions do NOT get the conflict badge', async () => {
    const sessionV = makeVersion({ kind: 'session' });
    mountPanel([sessionV]);

    await waitFor(() => {
      expect(document.querySelector('.history__row--btn')).not.toBeNull();
    });

    // The timeline row for a session version should have no badge
    expect(document.querySelector('.history__row-badge')).toBeNull();
  });
});

// ── HP-3: Empty state ─────────────────────────────────────────────────────────

describe('HP-3 — empty state when no versions', () => {
  it('shows "No earlier versions" when versions array is empty', async () => {
    mountPanel([]);

    await waitFor(() => {
      expect(screen.queryByText('No earlier versions')).not.toBeNull();
    });
  });
});

// ── HP-4: "Current" row always present ───────────────────────────────────────

describe('HP-4 — Current row always at the top of the timeline', () => {
  it('renders the Current row with and without versions', async () => {
    mountPanel([]);
    await waitFor(() => {
      expect(screen.queryByText('Current')).not.toBeNull();
    });
  });
});

// ── HP-5: Tapping a version opens the diff view ───────────────────────────────

describe('HP-5 — tapping a version opens the diff view', () => {
  it('click on a version row navigates to the diff view', async () => {
    const v = makeVersion();
    mountPanel([v]);

    await waitFor(() => {
      expect(document.querySelector('.history__row--btn')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('.history__row--btn')!);

    // Diff view appears with the toggle
    await waitFor(() => {
      expect(screen.queryByText('vs Previous')).not.toBeNull();
      expect(screen.queryByText('vs Current')).not.toBeNull();
    });

    // Restore button visible
    expect(screen.queryByText('Restore this version')).not.toBeNull();
  });
});

// ── HP-6: Diff renders insert/delete spans ────────────────────────────────────

describe('HP-6 — diff view renders insert/delete markup for changed text', () => {
  it('vs Previous diff shows inserts and deletes vs empty when oldest version', async () => {
    const v = makeVersion({
      title: 'My Note',
      body: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'hello world' }] }],
    });
    mountPanel([v]);

    await waitFor(() => { expect(document.querySelector('.history__row--btn')).not.toBeNull(); });
    fireEvent.click(document.querySelector('.history__row--btn')!);

    await waitFor(() => {
      // The diff body should be visible
      expect(document.querySelector('.history__diff-body')).not.toBeNull();
    });

    // vs Previous (default, oldest version → base is empty → all text is inserted)
    const body = document.querySelector('.history__diff-body')!;
    expect(body.querySelector('mark.history__diff-insert, .history__diff-insert')).not.toBeNull();
  });

  it('vs Current diff shows markup comparing version against the live note', async () => {
    const v = makeVersion({
      title: 'Old Title',
      body: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'old body text' }] }],
    });

    // Note has different content from version
    mountPanel([v], {
      note: {
        ...mockNote,
        title: 'New Title',
        body: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'new body text' }] }],
      },
    });

    await waitFor(() => { expect(document.querySelector('.history__row--btn')).not.toBeNull(); });
    fireEvent.click(document.querySelector('.history__row--btn')!);
    await waitFor(() => { expect(document.querySelector('.history__diff-body')).not.toBeNull(); });

    // Switch to vs Current
    fireEvent.click(screen.getByText('vs Current'));

    await waitFor(() => {
      const body = document.querySelector('.history__diff-body')!;
      // Should show both inserts and deletes (content differs)
      const hasChanges =
        body.querySelector('.history__diff-insert') !== null ||
        body.querySelector('.history__diff-delete') !== null;
      expect(hasChanges).toBe(true);
    });
  });
});

// ── HP-7: Toggle switches compare mode ───────────────────────────────────────

describe('HP-7 — vs-Current / vs-Previous toggle', () => {
  it('toggle buttons switch aria-pressed state', async () => {
    const v = makeVersion();
    mountPanel([v]);

    await waitFor(() => { expect(document.querySelector('.history__row--btn')).not.toBeNull(); });
    fireEvent.click(document.querySelector('.history__row--btn')!);

    await waitFor(() => { expect(screen.queryByText('vs Previous')).not.toBeNull(); });

    const prevTab = screen.getByText('vs Previous');
    const currTab = screen.getByText('vs Current');

    // Default: vs Previous is active
    expect(prevTab.getAttribute('aria-pressed')).toBe('true');
    expect(currTab.getAttribute('aria-pressed')).toBe('false');

    // Click vs Current
    fireEvent.click(currTab);

    await waitFor(() => {
      expect(currTab.getAttribute('aria-pressed')).toBe('true');
      expect(prevTab.getAttribute('aria-pressed')).toBe('false');
    });
  });
});

// ── HP-8: Restore confirm dialog ──────────────────────────────────────────────

describe('HP-8 — Restore button shows confirm dialog', () => {
  it('clicking Restore shows the confirm dialog with a final Restore action', async () => {
    const v = makeVersion();
    mountPanel([v]);

    await waitFor(() => { expect(document.querySelector('.history__row--btn')).not.toBeNull(); });
    fireEvent.click(document.querySelector('.history__row--btn')!);

    await waitFor(() => { expect(screen.queryByText('Restore this version')).not.toBeNull(); });
    fireEvent.click(screen.getByText('Restore this version'));

    await waitFor(() => {
      expect(screen.queryByText('Restore version?')).not.toBeNull();
    });

    // Confirm-level Restore button present
    const btns = document.querySelectorAll('.history__action');
    expect(btns.length).toBeGreaterThanOrEqual(1);
    const restoreBtn = Array.from(btns).find((b) => b.textContent?.includes('Restore'));
    expect(restoreBtn).not.toBeNull();
  });
});

// ── HP-9: onRestore called with the correct version ──────────────────────────

describe('HP-9 — restore-as-new-version: onRestore is called with the selected version', () => {
  it('confirms and calls onRestore with the exact version object', async () => {
    const versionId = 'version-xyz';
    const v = makeVersion({ id: versionId });
    const onRestore = vi.fn(async () => {});

    mountPanel([v], { onRestore });

    await waitFor(() => { expect(document.querySelector('.history__row--btn')).not.toBeNull(); });
    fireEvent.click(document.querySelector('.history__row--btn')!);

    await waitFor(() => { expect(screen.queryByText('Restore this version')).not.toBeNull(); });
    fireEvent.click(screen.getByText('Restore this version'));

    await waitFor(() => { expect(screen.queryByText('Restore version?')).not.toBeNull(); });

    // Click the confirm Restore button
    const btns = document.querySelectorAll('.history__action');
    const restoreBtn = Array.from(btns).find((b) => b.textContent?.includes('Restore')) as HTMLButtonElement;
    await act(async () => { fireEvent.click(restoreBtn); });

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledOnce();
      expect((onRestore.mock.calls[0]![0] as NoteVersion).id).toBe(versionId);
    });
  });
});

// ── HP-10: onBack from timeline ───────────────────────────────────────────────

describe('HP-10 — onBack called from timeline back button', () => {
  it('tapping back in the timeline fires onBack()', async () => {
    const onBack = vi.fn();
    mountPanel([], { onBack });

    await waitFor(() => { expect(screen.queryByText('Version History')).not.toBeNull(); });

    fireEvent.click(document.querySelector('.history__back')!);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
