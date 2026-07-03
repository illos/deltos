/**
 * ROAD-0010 — full-window note view + pop-out (desktop-only entry).
 *
 * The primitive: a bare full-window note view served at /note/:id/full — the note takes over the ENTIRE
 * window (no 3-region shell, no nav pane, no notes list), reusing NoteRoute's SAME editor composition
 * (variant="full") with the shell chrome stripped and the Full-screen / Pop-out ENTRY controls replaced
 * by a single back-to-regular EXIT control.
 *
 * FW-1  /note/:id/full mounts the note editor INSIDE AuthedShell but WITHOUT the 3-region shell chrome
 *       (no nav / list panes); the Exit-full-screen control is present and clicking it returns to
 *       /note/:id — where the 3-region shell reappears (master-detail).
 * FW-2  Desktop meta toolbar: the two new entry controls (Full screen + Pop out) render next to
 *       Version history / Delete; Full screen navigates to /note/:id/full; Pop out calls window.open
 *       with the full-route URL + popup features (no new tab).
 * FW-3  The full view carries NO fullscreen/popout entry controls (no full-screen-inside-full-screen).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

function makeNote(): Note {
  return {
    id: NOTE_ID, notebookId: NB_A, title: 'Full window note', properties: {}, body: [],
    version: 1, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', syncStatus: 'synced',
  };
}

/** Stub matchMedia so useIsDesktop resolves to the requested device class. */
function stubDevice(isDesktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: isDesktop, media: q, addEventListener() {}, removeEventListener() {},
  }));
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  await db.notes.put(makeNote() as Parameters<typeof db.notes.put>[0]);
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ── FW-1: the full route bypasses the 3-region shell (mounted via the REAL AuthedShell) ──────────────
describe('FW-1 — /note/:id/full is a bare full-window view (no 3-region shell); exit returns to it', () => {
  it('mounts the editor without nav/list panes, and Exit full screen navigates back to /note/:id', async () => {
    stubDevice(true); // desktop
    const { useAuthStore } = await import('../src/auth/store.js');
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'tok', sessionState: 'active' } as Parameters<typeof useAuthStore.setState>[0]);
    useNotebookStore.setState({ _ready: true, currentNotebookId: null });
    const { AuthedShell } = await import('../src/App.js');

    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}/full`]}>
        <AuthedShell />
      </MemoryRouter>,
    );

    // The bare full-window view: the editor loads (its meta toolbar carries the exit control) but the
    // desktop 3-region shell chrome is ABSENT.
    const exit = await screen.findByLabelText('Exit full screen');
    expect(exit).toBeTruthy();
    expect(document.querySelector('.shell-3region__nav')).toBeNull();   // no nav pane
    expect(document.querySelector('.shell-3region__list')).toBeNull();  // no notes list
    // No full-screen-inside-full-screen: the entry controls are gone from the full view.
    expect(screen.queryByLabelText('Full screen')).toBeNull();
    expect(screen.queryByLabelText('Pop out')).toBeNull();

    // Exit → /note/:id → the 3-region shell reappears (master-detail: nav + list mount).
    fireEvent.click(exit);
    await waitFor(() => expect(document.querySelector('.shell-3region__nav')).not.toBeNull());
    expect(document.querySelector('.shell-3region__list')).not.toBeNull();
  });
});

// ── FW-2 / FW-3: the entry controls live on the desktop meta toolbar (NoteRoute mounted standalone) ──
async function renderRegularNote() {
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  const view = render(
    <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/note/:id/full" element={<div>FULL VIEW ROUTE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());
  return view;
}

describe('FW-2 — desktop meta toolbar: Full screen + Pop out entry controls', () => {
  it('renders Full screen + Pop out next to Version history / Delete; Full screen navigates to the full route', async () => {
    stubDevice(true);
    await renderRegularNote();

    const fullBtn = screen.getByLabelText('Full screen');
    expect(fullBtn).toBeTruthy();
    expect(screen.getByLabelText('Pop out')).toBeTruthy();
    // Sits alongside the existing meta controls.
    expect(screen.getByLabelText('Version history')).toBeTruthy();
    expect(screen.getByLabelText('Delete note')).toBeTruthy();

    // Full screen → router navigate (in place) to /note/:id/full.
    fireEvent.click(fullBtn);
    await waitFor(() => expect(screen.queryByText('FULL VIEW ROUTE')).not.toBeNull());
  });

  it('Pop out calls window.open with the full-route URL + popup features (not a new tab)', async () => {
    stubDevice(true);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderRegularNote();

    fireEvent.click(screen.getByLabelText('Pop out'));
    expect(openSpy).toHaveBeenCalledWith(
      `/note/${NOTE_ID}/full`,
      '_blank',
      'popup,width=900,height=760',
    );
  });
});

describe('FW-3 — the full view (variant="full") has no entry controls, only the exit', () => {
  it('renders Exit full screen but neither Full screen nor Pop out', async () => {
    stubDevice(true);
    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}/full`]}>
        <Routes>
          <Route path="/note/:id/full" element={<NoteRoute variant="full" />} />
          <Route path="/note/:id" element={<div>REGULAR NOTE ROUTE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());

    expect(screen.getByLabelText('Exit full screen')).toBeTruthy();
    expect(screen.queryByLabelText('Full screen')).toBeNull();
    expect(screen.queryByLabelText('Pop out')).toBeNull();

    // Exit → back to the regular /note/:id view.
    fireEvent.click(screen.getByLabelText('Exit full screen'));
    await waitFor(() => expect(screen.queryByText('REGULAR NOTE ROUTE')).not.toBeNull());
  });
});
