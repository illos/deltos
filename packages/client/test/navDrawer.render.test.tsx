/**
 * Nav composability tests — proves NavContent is container-independent.
 *
 * ND-1  NavContent renders standalone (proves it works outside any specific container)
 * ND-2  DrawerNav is hidden (aria-hidden) when closed, visible when open
 * ND-3  NavContent renders inside AllNotebooksScreen (full-screen container)
 *
 * These are the composability-proof equivalent of CV-4 for collection views.
 * The container-independence is what lets the desktop multi-pane layout (#later)
 * embed NavContent as a left pane without touching the component.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { NavContent } from '../src/views/NavContent.js';
import { DrawerNav } from '../src/components/DrawerNav.js';
import { AllNotebooksScreen } from '../src/views/AllNotebooksScreen.js';
import { screen } from './renderHelpers.js';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  // Seed one notebook so the list has something to render
  await db.notebooks.put({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as import('@deltos/shared').NotebookId,
    name: 'My Notes',
    defaultCollectionView: 'list',
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

function Wrap({ children }: { children: React.ReactNode }) {
  return <BrowserRouter>{children}</BrowserRouter>;
}

describe('ND-1 — NavContent renders standalone', () => {
  it('mounts without a drawer or screen container', () => {
    render(<Wrap><NavContent /></Wrap>);
    // The nav landmark is present — container-independent
    expect(document.querySelector('.nav-content')).not.toBeNull();
  });
});

describe('ND-2 — DrawerNav reflects open state in aria-hidden', () => {
  it('is aria-hidden when closed and not aria-hidden when open', () => {
    const { rerender } = render(<Wrap><DrawerNav open={false} onClose={() => {}} /></Wrap>);
    const drawer = document.querySelector('.nav-drawer');
    expect(drawer?.getAttribute('aria-hidden')).toBe('true');

    rerender(<Wrap><DrawerNav open={true} onClose={() => {}} /></Wrap>);
    expect(drawer?.getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('.nav-drawer--open')).not.toBeNull();
    expect(document.querySelector('.nav-drawer__overlay')).not.toBeNull();
  });
});

describe('ND-3 — NavContent renders inside AllNotebooksScreen', () => {
  it('all-notebooks screen mounts the same nav-content component', () => {
    render(<Wrap><AllNotebooksScreen /></Wrap>);
    expect(document.querySelector('.all-notebooks')).not.toBeNull();
    expect(document.querySelector('.nav-content')).not.toBeNull();
  });
});
