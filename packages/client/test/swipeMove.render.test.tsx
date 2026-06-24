/**
 * #78 SwipeRow Move seam. The left-drag Move button renders ONLY when onMove is wired (so the WIP was inert
 * before HomeView wired it); clicking it invokes onMove (→ the host opens the notebook-picker sheet).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SwipeRow } from '../src/components/SwipeRow.js';

afterEach(cleanup);
const noop = () => {};
const base = { isOpen: false, onOpen: noop, onClose: noop, onDelete: noop, onDuplicate: noop };

describe('SwipeRow — Move seam (#78)', () => {
  it('renders the Move button when onMove is provided; ABSENT (inert) when omitted', () => {
    const { rerender } = render(<SwipeRow {...base} onMove={vi.fn()}><div>row</div></SwipeRow>);
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    rerender(<SwipeRow {...base}><div>row</div></SwipeRow>);
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('clicking Move invokes onMove', () => {
    const onMove = vi.fn();
    render(<SwipeRow {...base} onMove={onMove}><div>row</div></SwipeRow>);
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
