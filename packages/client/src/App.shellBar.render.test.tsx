import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { NotebookId } from '@deltos/shared';

/**
 * Mobile shell top-bar brand block (ROAD-0011 refinement, standing ui-features-need-rendered-ui-gate).
 *
 * Mounts the REAL AuthedShell in mobile mode and asserts the top-bar renders the δ deltos wordmark with the
 * current notebook as a tiny caption directly UNDERNEATH (stacked, not side-by-side):
 *   - the δ carries .dt-wordmark-delta — the SAME accent-serif brand treatment the desktop DrawerNav wordmark
 *     uses (color:var(--accent) in tokens.css), so the mark is brand-coloured, not plain,
 *   - the caption sits AFTER the wordmark inside the brand column (stacked beneath it), reuses .dt-label (the
 *     app's mono/uppercase small-label language), and carries the ellipsis-truncation contract on ONE line,
 *   - a long notebook name stays a SINGLE caption element (never wraps to a second caption line),
 *   - "All Notes" (the synthetic default, currentNotebookId=null) renders the same way,
 *   - the bar's height governor is untouched: the 44px .shell__nav-btn ("…") is still present and the bar has
 *     no fixed/inline height — the tight (line-height:1) two-line column stays within that 44px row, so the
 *     bar can't grow. jsdom does no layout, so the pixel height is feel-tested on deploy; this pins the
 *     structural contract the CSS keys on.
 */

// Mobile device class → the single-column mobile shell (with .shell__bar); NOT the desktop 3-region shell.
vi.mock('./lib/useIsDesktop.js', () => ({ useIsDesktop: () => false }));
// Non-touch → deckActive false (no Deck), so the shell chrome renders without the Deck subtree.
vi.mock('./lib/useTouchPrimary.js', () => ({ useTouchPrimary: () => false }));
vi.mock('./lib/useKeypadMode.js', () => ({ useKeypadMode: () => false }));
vi.mock('./lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('./lib/dnd/useFileNoteDnd.js', () => ({ useFileNoteDnd: () => null }));

// Sync + auth seams stubbed so the shell mounts without the real network/session machinery.
vi.mock('./lib/syncEngine.js', () => ({
  startSyncTriggers: () => () => {},
  syncNow: () => {},
  notifyQueueWrite: vi.fn(),
}));
vi.mock('./auth/store.js', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ sessionState: 'active' }),
}));

// Notebook pointer + reactive store: control currentNotebookId / current notebook per test.
const nbState: { current: { _ready: boolean; currentNotebookId: NotebookId | null; init: () => Promise<void> } } = {
  current: { _ready: true, currentNotebookId: null, init: async () => {} },
};
const currentNb: { current: { id: NotebookId; name: string } | null } = { current: null };
vi.mock('./lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) => sel(nbState.current),
}));
vi.mock('./db/storeHooks.js', () => ({
  useNotes: () => [],
  useNotebooks: () => [],
  useCurrentNotebook: () => currentNb.current,
}));

// Shell chrome children stubbed to trivial nodes — the brand block under test lives INLINE in AuthedShell, so
// stubbing the surrounding chrome keeps the mount light without touching what we assert on.
vi.mock('./components/DrawerNav.js', () => ({ DrawerNav: () => null }));
vi.mock('./components/ContextMenuSheet.js', () => ({ ContextMenuSheet: () => null }));
vi.mock('./components/BottomNav.js', () => ({ BottomNav: () => null }));
vi.mock('./components/SessionStatus.js', () => ({ SessionStatus: () => null }));
vi.mock('./components/SyncIndicator.js', () => ({ SyncIndicator: () => null }));
vi.mock('./components/ConflictToastHostSlot.js', () => ({ ConflictToastHostSlot: () => null }));
vi.mock('./components/UploadProgressHost.js', () => ({ UploadProgressHost: () => null }));
vi.mock('./components/ConflictBadgeSlot.js', () => ({ ConflictBadgeSlot: () => null }));
vi.mock('./components/DeckHost.js', () => ({
  DeckHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/NavSheet.js', () => ({
  NavSheetProvider: ({ children }: { children: ReactNode }) => children,
  NavSheet: () => null,
}));

// Imported AFTER the mocks (vi.mock is hoisted).
import { AuthedShell } from './App.js';

function mountShell() {
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <AuthedShell />
    </MemoryRouter>,
  );
  return container;
}

const brand = (c: HTMLElement) => c.querySelector('.shell__brand') as HTMLElement;
const mark = (c: HTMLElement) => c.querySelector('.shell__mark') as HTMLElement;
const caption = (c: HTMLElement) => c.querySelector('.shell__nb-caption') as HTMLElement;

beforeEach(() => {
  nbState.current = { _ready: true, currentNotebookId: null, init: async () => {} };
  currentNb.current = null;
});
afterEach(cleanup);

describe('mobile shell top-bar brand block', () => {
  it('renders the δ wordmark with the desktop accent-serif brand treatment (shared .dt-wordmark-delta)', () => {
    const c = mountShell();
    const b = brand(c);
    expect(b).not.toBeNull();
    // The mark line is the δ + "deltos" wordmark; the δ carries the SAME accent class the desktop wordmark uses.
    const delta = mark(c).querySelector('.dt-wordmark-delta') as HTMLElement;
    expect(delta).not.toBeNull();
    expect(delta.textContent).toBe('δ');
    // ...and this is the identical class the desktop DrawerNav wordmark applies (tokens.css → color:var(--accent)).
    const { container: nav } = render(
      <MemoryRouter>
        <span className="dt-wordmark-delta nav-content__wordmark-delta">δ</span>
      </MemoryRouter>,
    );
    expect(nav.querySelector('.dt-wordmark-delta')).not.toBeNull();
    expect(mark(c).textContent).toContain('deltos');
  });

  it('stacks the notebook caption UNDER the wordmark (caption after the mark inside the brand column)', () => {
    const c = mountShell();
    const b = brand(c);
    const cap = caption(c);
    expect(cap).not.toBeNull();
    // DOM order inside the flex column = visual stacking order: mark first, caption beneath it.
    const kids = Array.from(b.children);
    expect(kids.indexOf(mark(c))).toBeLessThan(kids.indexOf(cap));
    // The caption reuses the app's small-label language (.dt-label — mono / uppercase / faint / tracking).
    expect(cap.classList.contains('dt-label')).toBe(true);
  });

  it('shows the synthetic "All Notes" default as the caption when no specific notebook is current', () => {
    const c = mountShell();
    expect(caption(c).textContent).toBe('All Notes');
  });

  it('a long notebook name truncates on ONE caption line (ellipsis contract; never a second line)', () => {
    nbState.current = { _ready: true, currentNotebookId: 'nb-long' as NotebookId, init: async () => {} };
    currentNb.current = { id: 'nb-long' as NotebookId, name: 'A Really Very Extremely Long Notebook Name That Would Wrap' };
    const c = mountShell();
    const cap = caption(c);
    // Exactly ONE caption element (no wrap-to-second-caption), holding the full name; the CSS
    // (white-space:nowrap; overflow:hidden; text-overflow:ellipsis) clips it to one line.
    expect(c.querySelectorAll('.shell__nb-caption').length).toBe(1);
    expect(cap.textContent).toBe('A Really Very Extremely Long Notebook Name That Would Wrap');
  });

  it('does not grow the bar: the 44px nav-button governor is still present and the bar carries no fixed height', () => {
    const c = mountShell();
    const barEl = c.querySelector('.shell__bar') as HTMLElement;
    expect(barEl).not.toBeNull();
    // The bar's content height is governed by the .shell__nav-btn row (min-height:44px in styles.css), which
    // the tight two-line brand column stays under — so stacking the caption can't increase the bar height.
    expect(barEl.querySelector('.shell__nav-btn')).not.toBeNull();
    // No inline/fixed height was introduced on the bar (height stays padding + governed content, as before).
    expect(barEl.style.height).toBe('');
  });
});
