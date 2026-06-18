/**
 * #31 — BottomNav render tests.
 *
 * BN-1  Collapsed state: action row shows "New note" + "Search" buttons
 * BN-2  Tap handle → expanded: sheet and NavContent appear
 * BN-3  Tap scrim → collapses back to action row
 * BN-4  Tap handle again while expanded → collapses (toggle)
 * BN-5  BottomNav mounts inside BrowserRouter without crash (container-swap proof)
 */

import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { BottomNav } from '../src/components/BottomNav.js';
import type { NotebookId } from '@deltos/shared';

function Wrap({ children }: { children: React.ReactNode }) {
  return <BrowserRouter>{children}</BrowserRouter>;
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  // Seed a notebook so NavContent has data to render when expanded.
  await db.notebooks.put({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId,
    name: 'Notes',
    defaultCollectionView: 'list',
    isDefault: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BN-1 — collapsed state shows action row', () => {
  it('renders New note and Search action buttons when collapsed', () => {
    render(<Wrap><BottomNav /></Wrap>);
    // Action row present
    expect(document.querySelector('.bottom-nav__actions')).not.toBeNull();
    // Both default registry actions present
    expect(screen.getByRole('button', { name: 'New note' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDefined();
    // Sheet not present yet
    expect(document.querySelector('.bottom-nav__sheet')).toBeNull();
  });
});

describe('BN-2 — tap handle expands to sheet with NavContent', () => {
  it('handle click toggles to expanded state with nav sheet', async () => {
    render(<Wrap><BottomNav /></Wrap>);
    const handle = screen.getByRole('button', { name: 'Expand navigation' });

    await act(async () => { fireEvent.click(handle); });

    expect(document.querySelector('.bottom-nav--expanded')).not.toBeNull();
    expect(document.querySelector('.bottom-nav__sheet')).not.toBeNull();
    // NavContent is present inside the sheet
    expect(document.querySelector('.nav-content')).not.toBeNull();
    // Scrim is rendered
    expect(document.querySelector('.bottom-nav__scrim')).not.toBeNull();
  });
});

describe('BN-3 — tap scrim collapses the sheet', () => {
  it('clicking the scrim removes expanded state and scrim', async () => {
    render(<Wrap><BottomNav /></Wrap>);
    const handle = screen.getByRole('button', { name: 'Expand navigation' });

    await act(async () => { fireEvent.click(handle); });
    expect(document.querySelector('.bottom-nav--expanded')).not.toBeNull();

    const scrim = document.querySelector('.bottom-nav__scrim')!;
    await act(async () => { fireEvent.click(scrim); });

    expect(document.querySelector('.bottom-nav--expanded')).toBeNull();
    expect(document.querySelector('.bottom-nav__scrim')).toBeNull();
    expect(document.querySelector('.bottom-nav__actions')).not.toBeNull();
  });
});

describe('BN-4 — handle toggle: expanded → collapse', () => {
  it('tapping handle when expanded collapses', async () => {
    render(<Wrap><BottomNav /></Wrap>);

    // Expand
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    });
    expect(document.querySelector('.bottom-nav--expanded')).not.toBeNull();

    // Collapse
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    });
    expect(document.querySelector('.bottom-nav--expanded')).toBeNull();
  });
});

describe('BN-5 — container-swap: mounts without crash', () => {
  it('renders inside BrowserRouter as a standalone fragment', () => {
    expect(() => render(<Wrap><BottomNav /></Wrap>)).not.toThrow();
    expect(document.querySelector('.bottom-nav')).not.toBeNull();
  });
});
