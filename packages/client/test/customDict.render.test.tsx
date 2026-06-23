/**
 * CustomDictSection render tests (§5.2 manage-UI).
 *
 * CD-1  Empty state: renders "No custom words yet."
 * CD-2  Word list: renders words from observeWords reactively
 * CD-3  Remove: clicking the Remove button calls removeWord with the right word
 * CD-4  Add: typing a word + submitting calls addWord, clears the input
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { screen } from './renderHelpers.js';

// ── Mock dictionaryStore ──────────────────────────────────────────────────────

const mockObserveWords = vi.fn();
const mockAddWord = vi.fn(async () => {});
const mockRemoveWord = vi.fn(async () => {});

vi.mock('../src/lib/dictionaryStore.js', () => ({
  observeWords: (cb: (words: string[]) => void) => mockObserveWords(cb),
  addWord: (w: string) => mockAddWord(w),
  removeWord: (w: string) => mockRemoveWord(w),
  normalizeWord: (w: string) => w.trim().toLowerCase(),
}));

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountDict(initialWords: string[] = []) {
  // observeWords calls cb immediately with the initial list, returns unsubscribe
  mockObserveWords.mockImplementation((cb: (words: string[]) => void) => {
    cb(initialWords);
    return () => {};
  });
  const { CustomDictSection } = await import('../src/components/CustomDictSection.js');
  return render(<CustomDictSection />);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── CD-1: Empty state ─────────────────────────────────────────────────────────

describe('CD-1 — empty state', () => {
  it('shows "No custom words yet." when observeWords yields []', async () => {
    await mountDict([]);
    await waitFor(() => {
      expect(screen.queryByText('No custom words yet.')).not.toBeNull();
    });
  });
});

// ── CD-2: Word list renders ───────────────────────────────────────────────────

describe('CD-2 — word list renders', () => {
  it('renders each word from observeWords with a Remove button', async () => {
    await mountDict(['apple', 'banana']);
    await waitFor(() => {
      expect(screen.queryByText('apple')).not.toBeNull();
    });
    expect(screen.queryByText('banana')).not.toBeNull();
    // One Remove button per word
    const removeBtns = screen.queryAllByText('Remove');
    expect(removeBtns.length).toBe(2);
  });
});

// ── CD-3: Remove ─────────────────────────────────────────────────────────────

describe('CD-3 — remove word', () => {
  it('clicking Remove calls removeWord with the correct word', async () => {
    await mountDict(['deltos', 'prose']);
    await waitFor(() => {
      expect(screen.queryByText('deltos')).not.toBeNull();
    });
    // Each Remove button has aria-label="Remove <word>"
    const btn = screen.queryByRole('button', { name: 'Remove deltos' });
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await waitFor(() => {
      expect(mockRemoveWord).toHaveBeenCalledWith('deltos');
    });
  });
});

// ── CD-4: Add word ────────────────────────────────────────────────────────────

describe('CD-4 — add word', () => {
  it('typing a word and clicking Add calls addWord(normalized) and clears input', async () => {
    mockAddWord.mockResolvedValueOnce(undefined);
    await mountDict([]);
    await waitFor(() => {
      expect(screen.queryByLabelText('Add word to dictionary')).not.toBeNull();
    });
    const input = screen.getByLabelText('Add word to dictionary') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Foo  ' } });
    expect(input.value).toBe('  Foo  ');

    const addBtn = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(mockAddWord).toHaveBeenCalledWith('foo'); // normalized
    });
    // Input cleared after add
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('pressing Enter in the input also triggers addWord', async () => {
    mockAddWord.mockResolvedValueOnce(undefined);
    await mountDict([]);
    await waitFor(() => {
      expect(screen.queryByLabelText('Add word to dictionary')).not.toBeNull();
    });
    const input = screen.getByLabelText('Add word to dictionary');
    fireEvent.change(input, { target: { value: 'bark' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockAddWord).toHaveBeenCalledWith('bark');
    });
  });
});
