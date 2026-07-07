/**
 * ExportPanel render test (ROAD-0017 / standing ui-features-need-rendered-ui-gate). Mounts the REAL panel over
 * a mocked exportNote lib and proves the user-visible contract:
 *   - "Export as Markdown" invokes exportMarkdown(note);
 *   - "Export as PDF" / "Print" both invoke the single printNote path;
 *   - when printNote reports { ok:false } (the iOS-PWA no-op) a VISIBLE fallback alert appears — never swallowed.
 * A second block mounts the routed NoteRoute and proves the panel is REACHABLE off the ?export URL param
 * (the lazy chunk resolves under Suspense).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note } from '@deltos/shared';

const { exportMarkdown, printNote, showToast } = vi.hoisted(() => ({
  exportMarkdown: vi.fn(async () => {}),
  printNote: vi.fn(async () => ({ ok: true })),
  showToast: vi.fn(),
}));
vi.mock('../lib/exportNote.js', () => ({ exportMarkdown, printNote }));
vi.mock('../lib/toastEvents.js', () => ({ showToast }));

import { ExportPanel } from './ExportPanel.js';

const NOTE = {
  id: 'note-1',
  title: 'Test note',
  notebookId: null,
  properties: {},
  body: [{ id: 'p', type: 'paragraph', content: { segments: [{ text: 'body' }] } }],
} as unknown as Note;

beforeEach(() => {
  vi.clearAllMocks();
  printNote.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('ExportPanel', () => {
  it('Export as Markdown invokes exportMarkdown for the note', async () => {
    render(<ExportPanel note={NOTE} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText('Export as Markdown'));
    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith(NOTE));
  });

  it('Export as PDF and Print both invoke the printNote path', async () => {
    render(<ExportPanel note={NOTE} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText('Export as PDF'));
    await waitFor(() => expect(printNote).toHaveBeenCalledWith(NOTE));

    printNote.mockClear();
    fireEvent.click(screen.getByLabelText('Print'));
    await waitFor(() => expect(printNote).toHaveBeenCalledWith(NOTE));
  });

  it('surfaces a VISIBLE fallback when the print sheet never opens (ok:false)', async () => {
    printNote.mockResolvedValue({ ok: false });
    render(<ExportPanel note={NOTE} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText('Export as PDF'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t open the print sheet/i);
  });

  it('does NOT show the fallback on a successful print', async () => {
    render(<ExportPanel note={NOTE} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText('Print'));
    await waitFor(() => expect(printNote).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ── Reachability off the ?export URL param (the lazy NoteRoute seam) ──────────────────────────────
const routeState = vi.hoisted(() => ({ note: null as unknown }));
vi.mock('../db/storeHooks.js', () => ({ useNote: () => routeState.note, useNotebooks: () => [] }));
vi.mock('../db/conflict.js', () => ({ useNoteVersions: () => [] }));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => true }));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { put: vi.fn(), softDelete: vi.fn(), restore: vi.fn() } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/historyCapture.js', () => ({ getHistoryCapture: () => ({ open: vi.fn(), leave: vi.fn(), recordEdit: vi.fn() }) }));
vi.mock('../db/store.js', () => ({ getStore: () => ({ discardBlankNote: vi.fn() }) }));
vi.mock('../lib/noteContent.js', () => ({ noteHasContent: () => true }));
vi.mock('../components/SyncIndicator.js', () => ({ SyncIndicator: () => <div /> }));
vi.mock('../editor/NoteEditor.js', () => ({ NoteEditor: () => <div /> }));
vi.mock('../editor/views.js', () => ({ resolveNoteView: () => () => <div data-testid="resolved-view" /> }));

import { NoteRoute } from '../routes/NoteRoute.js';
import { useAuthStore } from '../auth/store.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('NoteRoute — ?export reachability', () => {
  beforeEach(() => {
    useAuthStore.setState({ accountId: 'acct', bearerToken: 'tok' });
    routeState.note = { ...(NOTE as object), id: UUID, hasConflict: false, syncStatus: 'synced', version: 1 };
  });
  afterEach(cleanup);

  it('renders the ExportPanel when ?export is set', async () => {
    render(
      <MemoryRouter initialEntries={[`/note/${UUID}?export`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    // The lazy chunk resolves under Suspense → the panel header appears.
    expect(await screen.findByRole('heading', { name: 'Export' })).not.toBeNull();
    expect(screen.getByLabelText('Export as Markdown')).not.toBeNull();
    // The editor view is swapped out while the panel is up.
    expect(screen.queryByTestId('resolved-view')).toBeNull();
  });
});
