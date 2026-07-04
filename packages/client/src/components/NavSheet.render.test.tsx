import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';

/**
 * NavSheet drag-up bottom sheet (ROAD-0011, standing ui-features-need-rendered-ui-gate).
 *
 * Mounts the REAL browsing nav surface as AuthedShell wires it — the NavSheetProvider controller feeding
 * BOTH the Deck nav arm zone (DeckNavLoadout) and the <NavSheet/> surface — and drives the gesture with
 * real pointer events through the real useDragAxis engine. Proves:
 *   - a drag UP past threshold off the Deck nav bar opens the sheet, and its pane matches the "…" menu's
 *     pane (both render the same NavContent — one source of truth),
 *   - drag-down on the grabber dismisses, backdrop tap dismisses,
 *   - a TAP on a Deck nav action still fires its navigation (the drag never steals the tap),
 *   - the gesture is inert when the provider is disabled (the note route / desktop): no sheet, no arming.
 *
 * jsdom does no layout (heights fall back to ~75vh in the controller); this asserts the wiring + state
 * transitions the gesture drives — the pixel feel is dogfooded on the live deploy.
 */

// ── Store seams stubbed so NavContent + DeckNavLoadout render without Dexie / liveQuery / sync. ──
const notebooks = [
  { id: 'nb1' as NotebookId, name: 'Work' },
  { id: 'nb2' as NotebookId, name: 'Ideas' },
];
vi.mock('../db/storeHooks.js', () => ({
  useNotes: () => [],
  useNotebooks: () => notebooks,
  useCurrentNotebook: () => null,
}));
vi.mock('../lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) =>
    sel({ currentNotebookId: null, setCurrentNotebook: async () => {} }),
}));
vi.mock('../db/mutateNotebooks.js', () => ({ mutateNotebooks: { create: vi.fn(async () => 'x') } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => false }));
vi.mock('../lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('../lib/upload/useFilePickerUpload.js', () => ({ useFilePickerUpload: () => undefined }));

import { NavSheetProvider, NavSheet } from './NavSheet.js';
import { DeckNavLoadout } from './DeckNavLoadout.js';
import { FullScreenNav } from './FullScreenNav.js';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

/** Mounts the browsing nav surface exactly as AuthedShell composes it (provider → arm zone + sheet). */
function mountShell(enabled = true) {
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <NavSheetProvider enabled={enabled}>
        {/* Arm zone — in the app this lives inside the Deck; here it's a direct child of the same provider. */}
        <DeckNavLoadout />
        <NavSheet />
      </NavSheetProvider>
    </MemoryRouter>,
  );
  return container;
}

const armZone = (c: HTMLElement) => c.querySelector('.deck-nav') as HTMLElement;
const grabber = (c: HTMLElement) => c.querySelector('.nav-sheet__grabber') as HTMLElement;
const sheet = (c: HTMLElement) => c.querySelector('.nav-sheet') as HTMLElement;

/** A vertical pointer drag from → to on an element (locks the y-axis in useDragAxis). */
function drag(el: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, clientY: from });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 100, clientY: to });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 100, clientY: to });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('NavSheet drag-up bottom sheet', () => {
  it('a drag UP past threshold off the Deck nav bar opens the sheet', () => {
    const c = mountShell();
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    drag(armZone(c), 700, 150); // big upward drag → reveal
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
  });

  it('the opened sheet reveals the SAME pane as the top-bar "…" menu (identical NavContent)', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    const sheetNav = sheet(c).querySelector('.nav-content') as HTMLElement;
    expect(sheetNav).not.toBeNull();

    // The "…" overflow menu renders the same NavContent inside FullScreenNav.
    const { container: fsc } = render(
      <MemoryRouter>
        <FullScreenNav open onClose={() => {}} />
      </MemoryRouter>,
    );
    const menuNav = fsc.querySelector('.nav-content') as HTMLElement;

    const norm = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();
    expect(norm(sheetNav)).toBe(norm(menuNav));
    // Sanity: the shared items are actually present in the sheet.
    for (const label of ['All Notes', 'Work', 'Ideas', 'Trash', 'Settings']) {
      expect(sheetNav.textContent).toContain(label);
    }
  });

  it('a drag DOWN on the grabber dismisses the open sheet', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    drag(grabber(c), 100, 650); // drag down → dismiss
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
  });

  it('a backdrop tap dismisses the open sheet', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    fireEvent.pointerDown(c.querySelector('.nav-sheet__backdrop') as HTMLElement);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
  });

  it('a TAP on a Deck nav action still fires its navigation (drag never steals the tap)', () => {
    const c = mountShell();
    const newBtn = c.querySelector('[aria-label="New note"]') as HTMLElement;
    // A tap = pointer down/up with no movement → useDragAxis never locks; the button click fires.
    fireEvent.pointerDown(newBtn, { pointerId: 2, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(newBtn, { pointerId: 2, clientX: 100, clientY: 400 });
    fireEvent.click(newBtn);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/new');
    // ...and the tap did NOT arm the sheet.
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
  });

  it('is inert when the provider is disabled (note route / desktop): no sheet, no arming', () => {
    const c = mountShell(false);
    // NavSheet renders nothing when the provider is disabled.
    expect(sheet(c)).toBeNull();
    // And an up-drag off the (unchanged) Deck nav bar does nothing — no sheet appears.
    drag(armZone(c), 700, 150);
    expect(sheet(c)).toBeNull();
  });
});
