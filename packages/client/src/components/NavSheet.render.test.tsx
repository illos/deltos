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

import { NavSheetProvider, NavSheet, useNavSheetArm } from './NavSheet.js';
import { DeckNavLoadout } from './DeckNavLoadout.js';
import { DeckHostProvider } from './DeckHost.js';
import { NavContent } from '../views/NavContent.js';
import { Deck, Keypad } from '../deck/index.js';
import type { DeckContext, DeckLoadoutRegistry } from '../deck/index.js';
import { _resetBodyScrollLockForTest } from '../lib/bodyScrollLock.js';

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

/** Mounts the REAL Deck via DeckHost (as AuthedShell does) so the Deck-core grabber affordance is present —
 *  the arm point that carries the gesture into the editor/keypad placement (app-wide arming). */
function mountDeckHost(enabled = true) {
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <NavSheetProvider enabled={enabled}>
        <DeckHostProvider enabled>
          <NavSheet />
        </DeckHostProvider>
      </NavSheetProvider>
    </MemoryRouter>,
  );
  return container;
}

/** A Deck in the editor 'text' context (keypad loadout) wired to the sheet arm exactly as DeckHost does —
 *  proves a keypad key tap still fires while the grabber gesture is armed above the keys. */
function KeypadDeck({ insert }: { insert: (t: string) => void }) {
  const arm = useNavSheetArm();
  const loadouts: DeckLoadoutRegistry = {
    text: <Keypad actions={{ insert, backspace: () => {}, enter: () => {} }} />,
  };
  return <Deck context={'text' as DeckContext} loadouts={loadouts} grabHandlers={arm} showGrabber={'onPointerDown' in arm} />;
}
function mountKeypad(insert: (t: string) => void) {
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <NavSheetProvider enabled>
        <KeypadDeck insert={insert} />
        <NavSheet />
      </NavSheetProvider>
    </MemoryRouter>,
  );
  return container;
}

const armZone = (c: HTMLElement) => c.querySelector('.deck-nav') as HTMLElement;
const grabber = (c: HTMLElement) => c.querySelector('.nav-sheet__grabber') as HTMLElement;
const deckGrab = (c: HTMLElement) => c.querySelector('.deck__grab') as HTMLElement;
const sheet = (c: HTMLElement) => c.querySelector('.nav-sheet') as HTMLElement;

/** A vertical pointer drag from → to on an element (locks the y-axis in useDragAxis). */
function drag(el: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, clientY: from });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 100, clientY: to });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 100, clientY: to });
}

beforeEach(() => { vi.clearAllMocks(); _resetBodyScrollLockForTest(); });
afterEach(() => { cleanup(); _resetBodyScrollLockForTest(); });

describe('NavSheet drag-up bottom sheet', () => {
  it('a drag UP past threshold off the Deck nav bar opens the sheet', () => {
    const c = mountShell();
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    drag(armZone(c), 700, 150); // big upward drag → reveal
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
  });

  it('the opened sheet reveals the shared NavContent pane (one source of truth)', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    const sheetNav = sheet(c).querySelector('.nav-content') as HTMLElement;
    expect(sheetNav).not.toBeNull();

    // The sheet is just a CONTAINER around NavContent — pin its content against NavContent rendered
    // directly (the single source of truth the desktop drawer also renders). The sheet drops the δ
    // wordmark (showWordmark=false, Jim: redundant with All Notes there), so the direct comparison mounts
    // with the same flag. No FullScreenNav anymore: the "…" button is repurposed to the ContextMenuSheet.
    const { container: direct } = render(
      <MemoryRouter>
        <NavContent showWordmark={false} />
      </MemoryRouter>,
    );
    const directNav = direct.querySelector('.nav-content') as HTMLElement;

    const norm = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();
    expect(norm(sheetNav)).toBe(norm(directNav));
    // Sanity: the shared items are actually present in the sheet.
    for (const label of ['All Notes', 'Work', 'Ideas', 'Trash', 'Settings']) {
      expect(sheetNav.textContent).toContain(label);
    }
    // ...but the δ wordmark is NOT in the sheet (it's redundant with All Notes here; kept on desktop).
    expect(sheetNav.querySelector('.nav-content__wordmark')).toBeNull();
    expect(sheetNav.textContent).not.toContain('deltos');
  });

  it('a drag DOWN on the grabber dismisses the open sheet', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    drag(grabber(c), 100, 650); // drag down → dismiss
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
  });

  it('a backdrop tap dismisses on CLICK (not pointerdown) so the intercept layer stays live through the click, and never navigates', () => {
    const c = mountShell();
    drag(armZone(c), 700, 150);
    const bd = c.querySelector('.nav-sheet__backdrop') as HTMLElement;
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    // REGRESSION (Jim's tap-through): dismissing on pointerdown flips the scrim inert BEFORE the click
    // hit-tests, so the synthesized click falls through to the row below and navigates. The fix dismisses
    // on CLICK — so a bare pointerdown must NOT close the sheet (the layer stays interactive for the click).
    fireEvent.pointerDown(bd, { pointerId: 9, clientX: 100, clientY: 300 });
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    // The click on the scrim dismisses — and dismissing never navigates the content beneath.
    fireEvent.click(bd);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/');
  });

  // ── Task 1 (backdrop intercept): a tap over the content while the sheet is DRAGGING (partly revealed) is
  //    swallowed by the scrim — it must never activate a note row beneath. ──────────────────────────────────
  it('a tap on the scrim mid-drag is intercepted (content below is never activated / navigated)', () => {
    const c = mountShell();
    const az = armZone(c);
    // Begin an arming drag and HOLD (locks the y-axis → --dragging; the scrim becomes the interactive
    // full-viewport intercept layer over ALL content, incl. any row the partly-revealed sheet exposes).
    fireEvent.pointerDown(az, { pointerId: 4, clientX: 100, clientY: 700 });
    fireEvent.pointerMove(az, { pointerId: 4, clientX: 100, clientY: 400 });
    expect(sheet(c).classList.contains('nav-sheet--dragging')).toBe(true);
    // A tap landing on the scrim while dragging does NOT reach / navigate the content below.
    fireEvent.click(c.querySelector('.nav-sheet__backdrop') as HTMLElement);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/');
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

  it('is inert when the provider is disabled (native-keyboard deck-top / desktop): no sheet, no arming, no grabber', () => {
    const c = mountShell(false);
    // NavSheet renders nothing when the provider is disabled.
    expect(sheet(c)).toBeNull();
    // And an up-drag off the (unchanged) Deck nav bar does nothing — no sheet appears.
    drag(armZone(c), 700, 150);
    expect(sheet(c)).toBeNull();
    // The Deck core grabber is also withheld while disabled (a drag-UP off a TOP bar is nonsense).
    const dh = mountDeckHost(false);
    expect(deckGrab(dh)).toBeNull();
    expect(sheet(dh)).toBeNull();
  });

  // ── Task 3: app-wide arming — the Deck-core grabber (present in BOTH bottom placements, incl. the editor
  //    keypad) carries the gesture, so the sheet arms beyond the browsing nav bar. ─────────────────────────
  it('app-wide arming: a drag UP off the Deck core grabber opens the sheet', () => {
    const c = mountDeckHost();
    const grab = deckGrab(c);
    expect(grab).not.toBeNull(); // the "pull me up" affordance is present whenever the Deck rides the bottom
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    drag(grab, 700, 150);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
  });

  it('a keypad key tap still fires (and does NOT arm the sheet) while the grabber gesture is live', () => {
    const insert = vi.fn();
    const c = mountKeypad(insert);
    // Tapping a letter key inserts (keypad key handler fires on pointerdown) and does NOT arm the sheet —
    // the keys are never an arm point (only the dedicated grabber above them is), so key taps are untouched.
    const q = c.querySelector('[aria-label="Q"]') as HTMLElement;
    expect(q).not.toBeNull();
    fireEvent.pointerDown(q, { pointerId: 5, clientX: 50, clientY: 500 });
    fireEvent.pointerUp(q, { pointerId: 5, clientX: 50, clientY: 500 });
    expect(insert).toHaveBeenCalledWith('q');
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    // ...and the grabber ABOVE the keys still arms the sheet in this keypad placement.
    drag(deckGrab(c), 700, 150);
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
  });

  // ── Task 1: the page is frozen (iOS-safe body scroll lock) while the sheet is up, restored on dismiss. ──
  it('freezes the page (body scroll lock) while the sheet is open and restores it on dismiss', () => {
    const c = mountShell();
    expect(document.body.style.position).toBe(''); // not locked at rest
    drag(armZone(c), 700, 150); // open
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    expect(document.body.style.position).toBe('fixed'); // page frozen while open
    drag(grabber(c), 100, 650); // dismiss
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(false);
    expect(document.body.style.position).toBe(''); // scroll restored on dismiss
  });

  // ── Task 2: content taps are gated while the sheet moves — a release over a row (the sheet just slid up
  //    under the finger) must NOT activate it; the one trailing settle-click is eaten too, then taps live. ──
  it('a release over a nav row mid-open does NOT activate it (content tap-gate + settle latch)', () => {
    const c = mountShell();
    const az = armZone(c);
    // Begin an arming drag (locks the y-axis → dragging state, content inert) but hold — do not release.
    fireEvent.pointerDown(az, { pointerId: 3, clientX: 100, clientY: 700 });
    fireEvent.pointerMove(az, { pointerId: 3, clientX: 100, clientY: 300 });
    expect(sheet(c).classList.contains('nav-sheet--dragging')).toBe(true);
    const trash = sheet(c).querySelector('a[href="/trash"]') as HTMLElement;
    expect(trash).not.toBeNull();
    // A click on a row WHILE dragging is swallowed — no navigation.
    fireEvent.click(trash);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/');
    // Release → settles open; the ONE trailing click (the release synthesizes it on the row) is eaten too.
    fireEvent.pointerUp(az, { pointerId: 3, clientX: 100, clientY: 300 });
    expect(sheet(c).classList.contains('nav-sheet--open')).toBe(true);
    expect(sheet(c).classList.contains('nav-sheet--dragging')).toBe(false);
    fireEvent.click(trash);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/');
    // ...then a real, deliberate tap navigates normally.
    fireEvent.click(trash);
    expect(c.querySelector('[data-testid="loc"]')?.textContent).toBe('/trash');
  });
});
