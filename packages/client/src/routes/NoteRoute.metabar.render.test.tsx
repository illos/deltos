/**
 * NoteRoute meta bar — rendered-UI gate (ui-features-need-rendered-ui-gate). The desktop §3 meta toolbar was
 * extracted to <NoteMetaBar> and, per Jim, now renders for EVERY note including FILE notes (history /
 * full-screen / pop-out / delete). These tests mount the routed tree and assert the DOM:
 *   - a file note on desktop gets the full bar (history + full-screen + pop-out + delete + sync indicator);
 *   - History opens to a sane EMPTY state for a file note (no version capture → "No earlier versions"), never a crash;
 *   - the /note/:id/full variant shows a single Exit control (no double exit, no entry controls);
 *   - a regular note renders the identical bar (zero behavior/DOM change from the extraction);
 *   - mobile omits the bar entirely.
 *
 * The resolved note view is stubbed (this suite owns the BAR, not the view body) — FileNoteView's own structure
 * is covered in FileNoteView.render.test.tsx.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';

// Mutable render state, hoisted so the mocks below can read it and each test can flip it.
const state = vi.hoisted(() => ({ note: null as unknown, versions: [] as unknown[], desktop: true }));

vi.mock('../db/storeHooks.js', () => ({ useNote: () => state.note, useNotebooks: () => [] }));
vi.mock('../db/conflict.js', () => ({ useNoteVersions: () => state.versions }));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => state.desktop }));
vi.mock('../db/mutate.js', () => ({
  mutateNotes: { put: vi.fn(async () => {}), softDelete: vi.fn(async () => {}), restore: vi.fn(async () => {}) },
}));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/historyCapture.js', () => ({
  getHistoryCapture: () => ({ open: vi.fn(), leave: vi.fn(), recordEdit: vi.fn() }),
}));
vi.mock('../db/store.js', () => ({ getStore: () => ({ discardBlankNote: vi.fn(async () => {}) }) }));
vi.mock('../lib/noteContent.js', () => ({ noteHasContent: () => true }));
vi.mock('../lib/toastEvents.js', () => ({ showActionToast: vi.fn() }));
// SyncIndicator + the resolved view + the fallbacks are stubbed to keep the mount light and deterministic.
vi.mock('../components/SyncIndicator.js', () => ({ SyncIndicator: () => <div data-testid="sync-indicator" /> }));
vi.mock('../editor/NoteEditor.js', () => ({ NoteEditor: () => <div data-testid="note-editor" /> }));
vi.mock('../components/ConflictView.js', () => ({ ConflictView: () => <div data-testid="conflict-view" /> }));
vi.mock('../editor/views.js', () => ({ resolveNoteView: () => () => <div data-testid="resolved-view" /> }));

import { NoteRoute } from './NoteRoute.js';

const UUID = '11111111-1111-4111-8111-111111111111';

function fileNote(): unknown {
  return {
    id: UUID,
    title: 'Q3-report.pdf',
    notebookId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 3,
    syncStatus: 'synced',
    properties: { fileType: { type: 'text', value: 'file' } },
    body: [{ id: 'b1', type: 'attachment', content: { hash: 'h', name: 'Q3-report.pdf', mime: 'application/pdf', size: 10 } }],
    hasConflict: false,
  };
}
function regularNote(): unknown {
  return { ...(fileNote() as object), title: 'Just a note', properties: {}, body: [] };
}

function mount(variant?: 'full') {
  return render(
    <MemoryRouter initialEntries={[`/note/${UUID}`]}>
      <Routes>
        <Route path="/note/:id" element={variant ? <NoteRoute variant={variant} /> : <NoteRoute />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ accountId: 'acct', bearerToken: 'tok' });
  state.versions = [];
  state.desktop = true;
});
afterEach(cleanup);

describe('NoteRoute meta bar — file notes get the same bar', () => {
  it('renders the full bar above a FILE note on desktop (history + full-screen + pop-out + delete + sync)', () => {
    state.note = fileNote();
    const { container } = mount();
    expect(container.querySelector('.editor__meta')).not.toBeNull();
    expect(screen.getByTestId('sync-indicator')).not.toBeNull();
    expect(screen.getByLabelText('Version history')).not.toBeNull();
    expect(screen.getByLabelText('Note info')).not.toBeNull();
    expect(screen.getByLabelText('Delete note')).not.toBeNull();
    expect(screen.getByLabelText('Full screen')).not.toBeNull();
    expect(screen.getByLabelText('Pop out')).not.toBeNull();
    // The resolved file view renders below the bar.
    expect(screen.getByTestId('resolved-view')).not.toBeNull();
  });

  it('Info button opens the full-screen InfoPanel (Created row present)', () => {
    state.note = fileNote();
    mount();
    fireEvent.click(screen.getByLabelText('Note info'));
    // The panel header + the common "Created" row render; the resolved view is swapped out.
    expect(screen.getByRole('heading', { name: 'Info' })).not.toBeNull();
    expect(screen.getByText('Created')).not.toBeNull();
    expect(screen.queryByTestId('resolved-view')).toBeNull();
  });

  it('History opens to a sane EMPTY state for a file note (no versions → "No earlier versions", no crash)', () => {
    state.note = fileNote();
    state.versions = [];
    mount();
    fireEvent.click(screen.getByLabelText('Version history'));
    expect(screen.getByText('Version History')).not.toBeNull();
    expect(screen.getByText('No earlier versions')).not.toBeNull();
  });

  it('the full variant shows a single Exit control (no double exit, no entry controls)', () => {
    state.note = fileNote();
    const { container } = mount('full');
    expect(screen.getAllByLabelText('Exit full screen')).toHaveLength(1);
    expect(screen.queryByLabelText('Full screen')).toBeNull();
    expect(screen.queryByLabelText('Pop out')).toBeNull();
    // The mobile-only .editor__full-exit fallback must NOT also render on desktop (that would be a 2nd exit).
    expect(container.querySelectorAll('.editor__full-exit')).toHaveLength(0);
    expect(screen.getByTestId('resolved-view')).not.toBeNull();
  });

  it('a regular note renders the identical bar (extraction is DOM-preserving)', () => {
    state.note = regularNote();
    mount();
    expect(screen.getByTestId('sync-indicator')).not.toBeNull();
    expect(screen.getByLabelText('Version history')).not.toBeNull();
    expect(screen.getByLabelText('Delete note')).not.toBeNull();
    expect(screen.getByLabelText('Full screen')).not.toBeNull();
    expect(screen.getByLabelText('Pop out')).not.toBeNull();
  });

  it('mobile omits the meta bar entirely', () => {
    state.note = fileNote();
    state.desktop = false;
    const { container } = mount();
    expect(container.querySelector('.editor__meta')).toBeNull();
    expect(screen.queryByLabelText('Version history')).toBeNull();
  });
});
