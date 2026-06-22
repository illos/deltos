/**
 * Task #68 — probe wiring sanity (the real gate is Jim's on-device report; jsdom can't observe whether
 * the native keyboard stays down). Asserts the contenteditable carries inputmode="none" from creation
 * and that the keypad keys drive PM edits (insert + backspace) without the keyboard.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KbProbe } from '../src/routes/KbProbe.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderProbe = () => render(<MemoryRouter><KbProbe /></MemoryRouter>);

const pm = () => document.querySelector('.kbprobe__editor .ProseMirror') as HTMLElement | null;
const key = (label: string) => [...document.querySelectorAll('.kbprobe__key')].find(
  (b) => b.textContent === label || b.getAttribute('aria-label') === label,
) as HTMLButtonElement | undefined;

describe('KbProbe — inputmode=none wiring', () => {
  it('mounts the editor with inputmode="none" set on the contenteditable', async () => {
    renderProbe();
    await waitFor(() => expect(pm()).not.toBeNull());
    expect(pm()!.getAttribute('inputmode')).toBe('none');
    expect(pm()!.getAttribute('contenteditable')).toBe('true');
  });

  it('keypad keys type + backspace into the editor (no native keyboard)', async () => {
    renderProbe();
    await waitFor(() => expect(pm()).not.toBeNull());

    fireEvent.pointerDown(key('t')!);
    fireEvent.pointerDown(key('h')!);
    fireEvent.pointerDown(key('e')!);
    expect(pm()!.textContent).toContain('the');

    fireEvent.pointerDown(key('Backspace')!);
    expect(pm()!.textContent).toContain('th');
    expect(pm()!.textContent).not.toContain('the');
  });
});
