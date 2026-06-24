/**
 * #78 NotebookPickerSheet — the move-note bottom sheet. Lists All Notes (uncategorize → null) + each
 * notebook; selecting calls onSelect with the right id; the current notebook is marked + disabled; backdrop
 * and Cancel close.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { NotebookId } from '@deltos/shared';
import { NotebookPickerSheet } from '../src/components/NotebookPickerSheet.js';

afterEach(cleanup);

const NB1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const notebooks = [{ id: NB1, name: 'Work' }, { id: NB2, name: 'Personal' }];

describe('NotebookPickerSheet', () => {
  it('lists All Notes + notebooks; selecting calls onSelect with the right id (null = uncategorize)', () => {
    const onSelect = vi.fn();
    render(<NotebookPickerSheet notebooks={notebooks} currentNotebookId={NB1} onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /All Notes/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Personal' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /All Notes/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    expect(onSelect).toHaveBeenCalledWith(NB2);
  });

  it('marks + DISABLES the note\'s current notebook (and All Notes when uncategorized)', () => {
    const { rerender } = render(
      <NotebookPickerSheet notebooks={notebooks} currentNotebookId={NB1} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect((screen.getByRole('button', { name: 'Work' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Personal' }) as HTMLButtonElement).disabled).toBe(false);

    rerender(<NotebookPickerSheet notebooks={notebooks} currentNotebookId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByRole('button', { name: /All Notes/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on backdrop + Cancel', () => {
    const onClose = vi.fn();
    const { container } = render(
      <NotebookPickerSheet notebooks={notebooks} currentNotebookId={NB1} onSelect={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.nb-sheet__backdrop')!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
