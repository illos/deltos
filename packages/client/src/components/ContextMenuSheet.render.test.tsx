import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ContextMenuSheet } from './ContextMenuSheet.js';

/**
 * ContextMenuSheet — the contextual options surface the top-bar "…" now opens (ROAD-0011, standing
 * ui-features-need-rendered-ui-gate). v1 is the empty shell: it must render the empty-state hint and a
 * comfortably-reachable close that dismisses; backdrop tap + Escape dismiss like the app's other overlays;
 * and it must be `inert` / aria-hidden (out of the tab + AT tree) when closed.
 */

afterEach(() => cleanup());

describe('ContextMenuSheet (the "…" options surface)', () => {
  it('renders the empty-state hint + a labelled Close button when open', () => {
    const { getByText, getByRole } = render(<ContextMenuSheet open onClose={() => {}} />);
    expect(getByText('Notebook options will live here')).not.toBeNull();
    // The dismiss control is a real button reachable by its accessible name (not a tiny corner ×).
    expect(getByRole('button', { name: 'Close' })).not.toBeNull();
  });

  it('the Close button dismisses (onClose fires)', () => {
    const onClose = vi.fn();
    const { getByRole } = render(<ContextMenuSheet open onClose={onClose} />);
    fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a backdrop tap dismisses', () => {
    const onClose = vi.fn();
    const { container } = render(<ContextMenuSheet open onClose={onClose} />);
    fireEvent.click(container.querySelector('.context-menu__backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape dismisses while open', () => {
    const onClose = vi.fn();
    render(<ContextMenuSheet open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is inert + aria-hidden when closed (out of the tab / AT tree)', () => {
    const { container } = render(<ContextMenuSheet open={false} onClose={() => {}} />);
    expect(container.querySelector('.context-menu')?.getAttribute('aria-hidden')).toBe('true');
    const panel = container.querySelector('.context-menu__panel') as HTMLElement;
    expect(panel.hasAttribute('inert')).toBe(true);
  });
});
