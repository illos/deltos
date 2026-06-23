/**
 * #69 Deck link fix — LinkEntryBar (the inline top-slot URL+Title form). Shows the keypad-typed buffers /
 * placeholders, marks the active field, gates apply on a non-empty URL, and fires focus/submit/cancel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LinkEntryBar } from '../src/editor/LinkEntryBar.js';

afterEach(cleanup);

const noop = () => {};

describe('LinkEntryBar', () => {
  it('shows placeholders when empty and disables apply (no URL)', () => {
    render(<LinkEntryBar title="" url="" activeField="title" onFocusField={noop} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('URL')).toBeTruthy();
    expect((screen.getByLabelText('Apply link') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the typed values and enables apply once the URL is non-empty', () => {
    render(<LinkEntryBar title="My site" url="example.com" activeField="url" onFocusField={noop} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('My site')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    expect((screen.getByLabelText('Apply link') as HTMLButtonElement).disabled).toBe(false);
  });

  it('tapping a field reports it as the keypad target', () => {
    const onFocusField = vi.fn();
    render(<LinkEntryBar title="" url="" activeField="title" onFocusField={onFocusField} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.pointerDown(screen.getByLabelText('URL'));
    expect(onFocusField).toHaveBeenCalledWith('url');
  });

  it('fires onSubmit / onCancel on the controls', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<LinkEntryBar title="t" url="example.com" activeField="url" onFocusField={noop} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.pointerDown(screen.getByLabelText('Apply link'));
    fireEvent.pointerDown(screen.getByLabelText('Cancel link'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
