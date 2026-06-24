/**
 * #101 — SyncIndicator is a pure colored BLIP (no visible text label) + tap-to-flush-then-hard-reload.
 * Two halves:
 *   - state → blip mapping (Jim's locked colors): synced=solid green · syncing/pending=pulsing green ·
 *     error=yellow ONLY · offline/local-only=grey/dim (NOT yellow — offline ≠ error, #85/#86).
 *   - tap: FLUSH (commit in-flight edits) BEFORE the hard reload — data-safety, must-not-lose-edits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { SyncIndicatorState } from '../src/lib/syncEngine.js';

// Ordered log so we can assert flush-happens-before-reload, not just that both ran.
const order: string[] = [];

let mockState: SyncIndicatorState = 'idle';
let mockQueueCount = 0;

vi.mock('../src/lib/syncEngine.js', () => ({
  getSyncState: () => mockState,
  subscribeSyncState: () => () => {},
  flushPushQueue: vi.fn(async () => { order.push('flushPushQueue'); }),
}));
vi.mock('../src/lib/pendingEditFlush.js', () => ({
  flushPendingEdits: vi.fn(async () => { order.push('flushPendingEdits'); }),
}));
vi.mock('../src/lib/reloadApp.js', () => ({
  reloadApp: vi.fn(() => { order.push('reloadApp'); }),
}));
vi.mock('../src/db/storeHooks.js', () => ({ useSyncQueueCount: () => mockQueueCount }));

import { SyncIndicator } from '../src/components/SyncIndicator.js';
import { useAuthStore } from '../src/auth/store.js';
import { flushPendingEdits } from '../src/lib/pendingEditFlush.js';
import { flushPushQueue } from '../src/lib/syncEngine.js';
import { reloadApp } from '../src/lib/reloadApp.js';

function setup(state: SyncIndicatorState, sessionActive: boolean, queueCount = 0) {
  mockState = state;
  mockQueueCount = queueCount;
  useAuthStore.setState({ sessionState: sessionActive ? 'active' : 'unauthed' });
  return render(<SyncIndicator />);
}

const dot = (c: HTMLElement) => c.querySelector('.sync-indicator') as HTMLButtonElement;

beforeEach(() => { order.length = 0; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SyncIndicator — state → blip mapping', () => {
  it('idle + active session → solid green (synced)', () => {
    const { container } = setup('idle', true);
    expect(dot(container).className).toContain('sync-indicator--synced');
  });

  it('idle + NO active session → grey/dim (local-only), NOT synced', () => {
    const { container } = setup('idle', false);
    const cls = dot(container).className;
    expect(cls).toContain('sync-indicator--offline');
    expect(cls).not.toContain('sync-indicator--synced');
  });

  it('syncing → pulsing green', () => {
    const { container } = setup('syncing', true);
    expect(dot(container).className).toContain('sync-indicator--syncing');
  });

  it('pending → pulsing green (folded into syncing)', () => {
    const { container } = setup('pending', true);
    expect(dot(container).className).toContain('sync-indicator--syncing');
  });

  it('error → yellow (error blip)', () => {
    const { container } = setup('error', true);
    expect(dot(container).className).toContain('sync-indicator--error');
  });

  it('offline → grey/dim, NOT error/yellow (#85/#86)', () => {
    const { container } = setup('offline', true);
    const cls = dot(container).className;
    expect(cls).toContain('sync-indicator--offline');
    expect(cls).not.toContain('sync-indicator--error');
  });
});

describe('SyncIndicator — #105 sonar ring (core dot stays solid, no dim pulse)', () => {
  const ring = (c: HTMLElement) => c.querySelector('.sync-indicator__ring');

  it('syncing → a ring is mounted (the expanding ping)', () => {
    const { container } = setup('syncing', true);
    expect(ring(container)).not.toBeNull();
  });

  it('pending → a ring is mounted (same heartbeat as syncing)', () => {
    const { container } = setup('pending', true);
    expect(ring(container)).not.toBeNull();
  });

  it('synced (idle) → NO ring (solid green only)', () => {
    const { container } = setup('idle', true);
    expect(ring(container)).toBeNull();
  });

  it('error → NO ring', () => {
    const { container } = setup('error', true);
    expect(ring(container)).toBeNull();
  });

  it('offline → NO ring', () => {
    const { container } = setup('offline', true);
    expect(ring(container)).toBeNull();
  });
});

describe('SyncIndicator — blip only, tooltip retained', () => {
  it('renders NO visible text label (only the dot)', () => {
    const { container } = setup('idle', true);
    expect(dot(container).textContent).toBe('');
    expect(container.querySelector('.sync-indicator__dot')).not.toBeNull();
  });

  it('keeps the descriptive tooltip + aria-label (and a tappable hint)', () => {
    const { container } = setup('idle', true);
    const btn = dot(container);
    expect(btn.getAttribute('title')).toContain('All changes synced');
    expect(btn.getAttribute('title')).toContain('Tap to reload');
    expect(btn.getAttribute('aria-label')).toContain('Sync status');
  });

  it('folds the pending count into the tooltip (visible N-count dropped)', () => {
    const { container } = setup('pending', true, 3);
    expect(dot(container).getAttribute('title')).toContain('3 changes queued');
  });
});

describe('SyncIndicator — tap flushes BEFORE reload', () => {
  it('tap → flushPendingEdits + flushPushQueue, THEN reload (in that order)', async () => {
    const { container } = setup('error', true);
    fireEvent.click(dot(container));

    await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(1));

    expect(flushPendingEdits).toHaveBeenCalledTimes(1);
    expect(flushPushQueue).toHaveBeenCalledTimes(1);
    // The critical invariant: both flushes complete before the reload (no edit lost to unload).
    expect(order).toEqual(['flushPendingEdits', 'flushPushQueue', 'reloadApp']);
  });

  it('is available in ALL states (harmless manual kick when already synced)', async () => {
    const { container } = setup('idle', true);
    fireEvent.click(dot(container));
    await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(1));
    expect(order.indexOf('flushPendingEdits')).toBeLessThan(order.indexOf('reloadApp'));
  });
});
