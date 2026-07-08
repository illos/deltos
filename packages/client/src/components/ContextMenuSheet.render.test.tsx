import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/**
 * ContextMenuSheet — the notebook "…" options surface (notebook-menu-and-keep-view.md §2, standing
 * ui-features-need-rendered-ui-gate). It now hosts NotebookMenuBody's four residents (Rename · Share · Sort ·
 * View). It must render those rows, hide Rename/Share for the synthetic All Notes (null notebook), and still
 * dismiss via Close / backdrop / Escape and be inert when closed. Store reads are mocked so the sheet mounts
 * in isolation.
 */

// A real notebook row (rename/share visible) unless overridden per-test via the mutable ref.
const nb = { current: { id: 'nb-1', name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } as
  { id: string; name: string; defaultCollectionView: string; noteSort: string } | null };
vi.mock('../db/storeHooks.js', () => ({ useCurrentNotebook: () => nb.current }));
vi.mock('../auth/store.js', () => ({
  useAuthStore: (sel: (s: { accountId: string | null }) => unknown) => sel({ accountId: 'acct-1' }),
}));
vi.mock('../db/mutateNotebooks.js', () => ({ mutateNotebooks: { rename: vi.fn(), setNoteSort: vi.fn(), setDefaultCollectionView: vi.fn() } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));

import { ContextMenuSheet } from './ContextMenuSheet.js';

afterEach(() => { cleanup(); nb.current = { id: 'nb-1', name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' }; });

describe('ContextMenuSheet (notebook "…" options surface)', () => {
  it('renders the four notebook residents for a real notebook', () => {
    const { getByText, getByRole } = render(
      <ContextMenuSheet open onClose={() => {}} notebookId={'nb-1' as never} />,
    );
    expect(getByText('Rename notebook')).not.toBeNull();
    expect(getByText('Share notebook')).not.toBeNull();
    expect(getByText('Sort')).not.toBeNull();
    expect(getByText('View')).not.toBeNull();
    expect(getByRole('button', { name: 'Close' })).not.toBeNull();
  });

  it('hides Rename + Share for the synthetic All Notes (null notebook), keeps Sort + View', () => {
    nb.current = null;
    const { queryByText, getByText } = render(
      <ContextMenuSheet open onClose={() => {}} notebookId={null} />,
    );
    expect(queryByText('Rename notebook')).toBeNull();
    expect(queryByText('Share notebook')).toBeNull();
    expect(getByText('Sort')).not.toBeNull();
    expect(getByText('View')).not.toBeNull();
  });

  it('the Close button dismisses (onClose fires)', () => {
    const onClose = vi.fn();
    const { getByRole } = render(<ContextMenuSheet open onClose={onClose} notebookId={'nb-1' as never} />);
    fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a backdrop tap dismisses', () => {
    const onClose = vi.fn();
    const { container } = render(<ContextMenuSheet open onClose={onClose} notebookId={'nb-1' as never} />);
    fireEvent.click(container.querySelector('.context-menu__backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape dismisses while open', () => {
    const onClose = vi.fn();
    render(<ContextMenuSheet open onClose={onClose} notebookId={'nb-1' as never} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is inert + aria-hidden when closed (out of the tab / AT tree)', () => {
    const { container } = render(<ContextMenuSheet open={false} onClose={() => {}} notebookId={'nb-1' as never} />);
    expect(container.querySelector('.context-menu')?.getAttribute('aria-hidden')).toBe('true');
    const panel = container.querySelector('.context-menu__panel') as HTMLElement;
    expect(panel.hasAttribute('inert')).toBe(true);
  });
});
