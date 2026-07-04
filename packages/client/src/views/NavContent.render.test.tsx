import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NotebookId } from '@deltos/shared';

/**
 * NavContent — the single composable nav pane rendered by three containers (mobile drag-up sheet,
 * desktop DrawerNav, legacy BottomNav). Standing ui-features-need-rendered-ui-gate: mount the routed
 * tree + assert DOM. Two Jim corrections proven here:
 *   1. showWordmark prop — default true (kept on desktop DrawerNav, the only place the brand shows);
 *      the drag-up sheet passes false (redundant with All Notes there).
 *   2. Route-aware active highlight — the highlight answers "where am I NOW": Settings row on /settings*,
 *      Trash row on /trash, and the active notebook on every notes route (as before). Purely
 *      presentational — the persisted currentNotebookId is never mutated.
 */

const notebooks = [
  { id: 'nb1' as NotebookId, name: 'Work' },
  { id: 'nb2' as NotebookId, name: 'Ideas' },
];
// currentNotebookId drives the notes-route highlight; hoisted so tests can flip it.
const store = { currentNotebookId: 'nb1' as NotebookId | null };
vi.mock('../db/storeHooks.js', () => ({
  useNotes: () => [],
  useNotebooks: () => notebooks,
}));
vi.mock('../lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) =>
    sel({ currentNotebookId: store.currentNotebookId, setCurrentNotebook: async () => {} }),
}));
vi.mock('../db/mutateNotebooks.js', () => ({ mutateNotebooks: { create: vi.fn(async () => 'x') } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => false }));
vi.mock('../lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));

import { NavContent } from './NavContent.js';
import { DrawerNav } from '../components/DrawerNav.js';

afterEach(() => { cleanup(); store.currentNotebookId = 'nb1' as NotebookId; });

function mount(path: string, node: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>).container;
}

// Row helpers keyed off the rendered DOM.
const currentItem = (c: HTMLElement) => c.querySelector('.nav-content__item--current');
const currentFooter = (c: HTMLElement) => c.querySelector('.nav-content__footer-link--current');
const rowText = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

describe('NavContent — δ wordmark visibility (container-driven prop)', () => {
  it('renders the wordmark by default (desktop DrawerNav keeps the brand)', () => {
    const c = mount('/', <DrawerNav open onClose={() => {}} />);
    expect(c.querySelector('.nav-content__wordmark')).not.toBeNull();
    expect(c.textContent).toContain('deltos');
  });

  it('drops the wordmark when showWordmark={false} (the drag-up sheet)', () => {
    const c = mount('/', <NavContent showWordmark={false} />);
    expect(c.querySelector('.nav-content__wordmark')).toBeNull();
    expect(c.textContent).not.toContain('deltos');
    // ...but the nav pane itself (notebooks, footer) still renders.
    expect(c.querySelector('.nav-content')).not.toBeNull();
    expect(c.textContent).toContain('All Notes');
  });
});

describe('NavContent — route-aware active highlight (all containers)', () => {
  it('on a notes route (/), the active notebook row highlights and no footer row does', () => {
    const c = mount('/', <NavContent />);
    expect(rowText(currentItem(c))).toContain('Work'); // nb1 = currentNotebookId
    expect(currentFooter(c)).toBeNull();
  });

  it('on a note route (/note/:id), the active notebook still highlights', () => {
    const c = mount('/note/abc', <NavContent />);
    expect(rowText(currentItem(c))).toContain('Work');
    expect(currentFooter(c)).toBeNull();
  });

  it('All-Notes synthetic aggregate: currentNotebookId=null on / highlights All Notes', () => {
    store.currentNotebookId = null;
    const c = mount('/', <NavContent />);
    expect(rowText(currentItem(c))).toContain('All Notes');
    expect(currentFooter(c)).toBeNull();
  });

  it('on /settings, the Settings footer row is active and NO notebook row is', () => {
    const c = mount('/settings', <NavContent />);
    expect(currentItem(c)).toBeNull(); // notebook highlight suppressed
    expect(rowText(currentFooter(c))).toContain('Settings');
  });

  it('on /settings/:tab, the Settings footer row is active and NO notebook row is', () => {
    const c = mount('/settings/appearance', <NavContent />);
    expect(currentItem(c)).toBeNull();
    expect(rowText(currentFooter(c))).toContain('Settings');
  });

  it('on /trash, the Trash footer row is active and NO notebook row is', () => {
    const c = mount('/trash', <NavContent />);
    expect(currentItem(c)).toBeNull();
    expect(rowText(currentFooter(c))).toContain('Trash');
  });

  it('settings/trash suppress even the All-Notes highlight (currentNotebookId=null)', () => {
    store.currentNotebookId = null;
    const c = mount('/settings', <NavContent />);
    expect(currentItem(c)).toBeNull();
    expect(rowText(currentFooter(c))).toContain('Settings');
  });
});
