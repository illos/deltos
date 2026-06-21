/**
 * #33 — body scroll-lock tests.
 *
 * SL-1  lockBodyScroll() sets body to position:fixed + top offset
 * SL-2  unlockBodyScroll() removes the fix and restores body style
 * SL-3  Multiple lock() calls are reference-counted; one unlock() doesn't release
 * SL-4  unlock() is safe to call when not locked (no-op)
 * SL-5  BottomNav expanding locks body scroll
 * SL-6  BottomNav collapsing unlocks body scroll
 * SL-7  BottomNav unmounting while expanded unlocks body scroll
 */

import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import {
  lockBodyScroll,
  unlockBodyScroll,
  _resetBodyScrollLockForTest,
} from '../src/lib/bodyScrollLock.js';
import { BottomNav } from '../src/components/BottomNav.js';
import type { NotebookId } from '@deltos/shared';

function Wrap({ children }: { children: React.ReactNode }) {
  return <BrowserRouter>{children}</BrowserRouter>;
}

beforeEach(async () => {
  _resetBodyScrollLockForTest();
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  await db.notebooks.put({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId,
    name: 'Notes', defaultCollectionView: 'list',
    version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null, syncSeq: 1,
  });
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetBodyScrollLockForTest();
});

describe('SL-1 — lockBodyScroll sets position:fixed', () => {
  it('applies fixed positioning to body', () => {
    lockBodyScroll();
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.width).toBe('100%');
  });
});

describe('SL-2 — unlockBodyScroll restores body', () => {
  it('clears fixed positioning after lock+unlock', () => {
    lockBodyScroll();
    unlockBodyScroll();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.width).toBe('');
  });
});

describe('SL-3 — reference counting: two locks need two unlocks', () => {
  it('body stays locked until all callers unlock', () => {
    lockBodyScroll();
    lockBodyScroll();
    unlockBodyScroll(); // count → 1, still locked
    expect(document.body.style.position).toBe('fixed');
    unlockBodyScroll(); // count → 0, released
    expect(document.body.style.position).toBe('');
  });
});

describe('SL-4 — unlock is safe when already unlocked', () => {
  it('calling unlockBodyScroll with no active lock is a no-op', () => {
    expect(() => unlockBodyScroll()).not.toThrow();
    expect(document.body.style.position).toBe('');
  });
});

describe('SL-5 — BottomNav expand locks body scroll', () => {
  it('body gets position:fixed when sheet expands', async () => {
    render(<Wrap><BottomNav /></Wrap>);
    const handle = document.querySelector('.bottom-nav__handle') as HTMLButtonElement;
    await act(async () => { fireEvent.click(handle); });
    expect(document.body.style.position).toBe('fixed');
  });
});

describe('SL-6 — BottomNav collapse unlocks body scroll', () => {
  it('body position cleared when sheet collapses', async () => {
    render(<Wrap><BottomNav /></Wrap>);
    const handle = document.querySelector('.bottom-nav__handle') as HTMLButtonElement;
    await act(async () => { fireEvent.click(handle); });
    expect(document.body.style.position).toBe('fixed');
    const scrim = document.querySelector('.bottom-nav__scrim') as HTMLElement;
    await act(async () => { fireEvent.click(scrim); });
    expect(document.body.style.position).toBe('');
  });
});

describe('SL-7 — unmounting while expanded unlocks body scroll', () => {
  it('body unlocked when BottomNav unmounts in expanded state', async () => {
    const { unmount } = render(<Wrap><BottomNav /></Wrap>);
    const handle = document.querySelector('.bottom-nav__handle') as HTMLButtonElement;
    await act(async () => { fireEvent.click(handle); });
    expect(document.body.style.position).toBe('fixed');
    await act(async () => { unmount(); });
    expect(document.body.style.position).toBe('');
  });
});
