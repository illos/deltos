/**
 * DeckNavLoadout (#69 nav loadout + mobile file-note creation, standing ui-features-need-rendered-ui-gate) —
 * mounts the REAL loadout and proves the navigation controls render + the Upload affordance is wired:
 *   - all three actions render (New + Search + Upload);
 *   - the hidden picker is a plain multi-file input with NO `capture` (critical — `capture` HIDES iOS's
 *     native "Scan Documents" option) and no restrictive `accept` (any file type is a valid file note);
 *   - selecting files routes each File through the reused createFileNote (once per file), then resets the
 *     input value so re-picking the SAME file re-fires.
 *
 * The heavy upload path (blobClient / direct-to-R2) is mocked at the db/mutate + sync/toast seams so the
 * wiring is exercised without standing up Dexie or a real upload; the lazy filePickerUpload chunk itself
 * runs for real (proving the button → lazy chunk → createFileNote path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Reused mint path — spy it (once per selected file), and avoid pulling in Dexie/store.
const { createFileNote } = vi.hoisted(() => ({
  createFileNote: vi.fn(async () => ({ id: 'n', notebookId: null })),
}));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { createFileNote } }));
// Sync trigger + toast are side effects we don't want in the render test.
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('../lib/toastEvents.js', () => ({ showToast: vi.fn() }));

import { DeckNavLoadout } from './DeckNavLoadout.js';

function mount() {
  const { container } = render(
    <MemoryRouter>
      <DeckNavLoadout />
    </MemoryRouter>,
  );
  return container;
}

beforeEach(() => createFileNote.mockClear());
afterEach(cleanup);

describe('DeckNavLoadout', () => {
  it('renders the three navigation actions (New + Search + Upload)', () => {
    const c = mount();
    expect(c.querySelector('[aria-label="New note"]')).not.toBeNull();
    expect(c.querySelector('[aria-label="Search"]')).not.toBeNull();
    const upload = c.querySelector('[aria-label="Upload file"]');
    expect(upload).not.toBeNull();
    expect(upload?.textContent).toMatch(/upload/i);
  });

  it('the hidden picker is a plain multi-file input with NO capture attribute', () => {
    const c = mount();
    const input = c.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
    // CRITICAL: `capture` must be absent — it would hide iOS's native document scanner.
    expect(input.hasAttribute('capture')).toBe(false);
    // No restrictive accept — every file type is a valid file note (and an image filter would kill the scanner).
    const accept = input.getAttribute('accept');
    expect(accept === null || accept === '' || accept === '*/*').toBe(true);
  });

  it('selecting files invokes the reused createFileNote once per file, then resets the input value', async () => {
    const c = mount();
    const input = c.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['a'], 'scan.pdf', { type: 'application/pdf' }),
      new File(['b'], 'photo.png', { type: 'image/png' }),
    ];

    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(createFileNote).toHaveBeenCalledTimes(2));
    expect(createFileNote).toHaveBeenCalledWith(files[0]);
    expect(createFileNote).toHaveBeenCalledWith(files[1]);
    // Reset so re-selecting the same file fires change again.
    expect(input.value).toBe('');
  });
});
