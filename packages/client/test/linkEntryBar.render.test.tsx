/**
 * #69 Deck link fix — LinkEntryBar (the inline top-slot URL field). Shows the keypad-typed buffer / a
 * placeholder, gates apply on a non-empty URL, and fires submit/cancel on the controls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LinkEntryBar } from '../src/editor/LinkEntryBar.js';

afterEach(cleanup);

describe('LinkEntryBar', () => {
  it('shows the placeholder when empty and disables apply', () => {
    render(<LinkEntryBar url="" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Type the link URL…')).toBeTruthy();
    expect((screen.getByLabelText('Apply link') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the typed URL and enables apply', () => {
    render(<LinkEntryBar url="example.com/x" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('example.com/x')).toBeTruthy();
    expect((screen.getByLabelText('Apply link') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fires onSubmit / onCancel on the controls', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<LinkEntryBar url="example.com" onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.pointerDown(screen.getByLabelText('Apply link'));
    fireEvent.pointerDown(screen.getByLabelText('Cancel link'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
