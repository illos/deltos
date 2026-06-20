import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResizeHandle } from './ResizeHandle.js';
import { useResizableListPane } from '../lib/useResizableListPane.js';
import {
  DEFAULT_LIST_PANE_WIDTH,
  MIN_LIST_PANE_WIDTH,
  MAX_LIST_PANE_WIDTH,
  readListPaneWidth,
  writeListPaneWidth,
} from '../db/panePointer.js';

/**
 * Lane 2 Pass B — the drag-to-resize foundation (the `--handle` divider). Routed-tree-style DOM gate
 * (ui-features-need-rendered-ui-gate): proves the handle renders as a real accessible separator,
 * keyboard resize moves AND persists the pane width, the range clamps (the note pane can't be
 * starved), and the persisted width re-loads on mount (render-before-data swap).
 */
function Harness() {
  const pane = useResizableListPane();
  return (
    <div>
      <div data-testid="pane" style={{ width: pane.width }} />
      <ResizeHandle handle={pane.handleProps} />
    </div>
  );
}

beforeEach(async () => {
  const { db } = await import('../db/schema.js');
  await db.deviceState.clear();
});
afterEach(cleanup);

describe('ResizeHandle + useResizableListPane (Pass B resize foundation)', () => {
  it('renders an accessible vertical separator carrying the pill + pane-width range', () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(Number(sep.getAttribute('aria-valuemin'))).toBe(MIN_LIST_PANE_WIDTH);
    expect(Number(sep.getAttribute('aria-valuemax'))).toBe(MAX_LIST_PANE_WIDTH);
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(DEFAULT_LIST_PANE_WIDTH);
    expect(sep.getAttribute('tabindex')).toBe('0');
    expect(sep.querySelector('.resize-handle__pill')).not.toBeNull();
  });

  it('keyboard ←/→ resizes the pane and persists the width to deviceState', async () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(DEFAULT_LIST_PANE_WIDTH + 16);
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(DEFAULT_LIST_PANE_WIDTH - 16);
    await waitFor(async () => expect(await readListPaneWidth()).toBe(DEFAULT_LIST_PANE_WIDTH - 16));
  });

  it('clamps at the max — the list cannot grow past MAX and starve the note pane', () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    for (let i = 0; i < 100; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(MAX_LIST_PANE_WIDTH);
  });

  it('loads the persisted width on mount (render-before-data → swap to stored)', async () => {
    await writeListPaneWidth(420);
    render(<Harness />);
    const sep = screen.getByRole('separator');
    await waitFor(() => expect(Number(sep.getAttribute('aria-valuenow'))).toBe(420));
  });
});
