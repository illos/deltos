/**
 * /kbprobe route wiring (the real gate is on-device). Asserts the contenteditable carries
 * inputmode="none" from creation and that the route mounts the real #69 CustomKeyboard grid (typing
 * behavior is covered in customKeyboard.render.test).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { KbProbe } from '../src/routes/KbProbe.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderProbe = () => render(<MemoryRouter><KbProbe /></MemoryRouter>);
const pm = () => document.querySelector('.kbprobe__editor .ProseMirror') as HTMLElement | null;

describe('KbProbe — inputmode=none + custom keyboard mounted', () => {
  it('mounts the editor with inputmode="none" and the CustomKeyboard grid', async () => {
    renderProbe();
    await waitFor(() => expect(pm()).not.toBeNull());
    expect(pm()!.getAttribute('inputmode')).toBe('none');
    expect(pm()!.getAttribute('contenteditable')).toBe('true');
    // The real #69 grid is mounted (not the old throwaway keypad).
    expect(document.querySelector('.kb__grid')).not.toBeNull();
    expect(document.querySelector('.kb__key[aria-label="Q"]')).not.toBeNull();
  });
});
