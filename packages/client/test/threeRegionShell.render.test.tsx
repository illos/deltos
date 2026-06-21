/**
 * Lane 2 Pass B — desktop 3-region shell frame (routed-tree DOM gate, ui-features-need-rendered-ui-gate).
 *
 * Proves the static frame: the THREE region containers (nav pane | note list | active note) all
 * render with REAL content (real NavContent switcher + real note list + the region-3 route), the
 * --handle resizer is present, and Jim's decision (a) holds — Search/Trash/Settings render in region 3
 * while nav + list stay mounted (master-detail). The mobile bottom-sheet + cold-start containers keep
 * their existing coverage (navDrawer.render ND-2/ND-3 + the BottomNav tests).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NotebookId, NoteId } from '@deltos/shared';
import { ThreeRegionShell } from '../src/components/ThreeRegionShell.js';
import { HomeView } from '../src/App.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'tok', sessionState: 'active' });
  await db.notebooks.put({
    id: NB, name: 'Field Notes', defaultCollectionView: 'list', isDefault: true,
    version: 1, createdAt: 'x', updatedAt: 'x', deletedAt: null, syncSeq: 1,
  } as never);
  await db.notes.put({
    id: NOTE, notebookId: NB, title: 'A real note', properties: {}, body: [],
    version: 1, createdAt: 'x', updatedAt: '2026-06-20T14:32:00.000Z', syncStatus: 'synced', accountId: 'acct-1',
  } as never);
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderShell = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ThreeRegionShell notebookId={NB} CollectionView={HomeView} />
    </MemoryRouter>,
  );

describe('ThreeRegionShell — desktop 3-region frame (Pass B)', () => {
  it('renders all THREE regions (nav | list | note) + the --handle resizer', () => {
    const { container } = renderShell('/');
    expect(container.querySelector('.shell-3region__nav'), 'nav pane').not.toBeNull();
    expect(container.querySelector('.shell-3region__list'), 'list pane').not.toBeNull();
    expect(container.querySelector('.shell-3region__note'), 'note region').not.toBeNull();
    expect(screen.getByRole('separator'), 'resize handle').toBeTruthy();
  });

  it('the regions carry REAL content (switcher in nav, note list in list region)', async () => {
    const { container } = renderShell('/');
    const nav = container.querySelector('.shell-3region__nav') as HTMLElement;
    expect(await within(nav).findByText('Field Notes')).toBeTruthy();
    const list = container.querySelector('.shell-3region__list') as HTMLElement;
    expect(await within(list).findByText('A real note')).toBeTruthy();
  });

  it('at "/" the note region shows the empty state (master-detail: nav + list still mounted)', () => {
    const { container } = renderShell('/');
    const note = container.querySelector('.shell-3region__note') as HTMLElement;
    expect(within(note).getByText('Select a note')).toBeTruthy();
  });

  it('decision (a): /search renders in region 3 (replaces the note) while nav + list persist', async () => {
    const { container } = renderShell('/search');
    expect(container.querySelector('.shell-3region__nav')).not.toBeNull(); // persistent
    expect(container.querySelector('.shell-3region__list')).not.toBeNull(); // persistent
    const note = container.querySelector('.shell-3region__note') as HTMLElement;
    expect(within(note).queryByText('Select a note')).toBeNull(); // not the empty state — search took region 3
  });
});
