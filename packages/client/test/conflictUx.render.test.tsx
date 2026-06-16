/**
 * CAV-8 — conflict surface: toast + persistent badge render.
 *
 * Matrix row: CAV-8 "Conflict surface — toast + persistent badge"
 * Tier: [CLI-auto: render] (jsdom)
 * Owner: gruntSys2
 *
 * Pass conditions:
 *   - A non-blocking toast renders with the exact spec message after showConflictToast()
 *   - Toast is tappable / has a dismiss button
 *   - Toast disappears after dismiss
 *   - Notes with hasConflict=true show a persistent conflict badge
 *   - Notes with hasConflict=false/absent show no badge
 *   - Badge has an accessible label
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import React from 'react';
import type { Note, NotebookId } from '@deltos/shared';
import type { ClientNote } from '../src/db/schema.js';
import { ToastHost } from '../src/components/ToastHost.js';
import { ConflictBadgeSlot } from '../src/components/ConflictBadgeSlot.js';
import {
  showConflictToast,
  dismissToast,
  getToasts,
} from '../src/lib/toastEvents.js';
import { renderWithProviders, screen, waitFor, within } from './renderHelpers.js';

const NB = 'nb-test-00000000-0000-4000-8000-000000000002' as NotebookId;

function makeNote(overrides: Partial<ClientNote> = {}): ClientNote {
  return {
    id: 'note-cav8-0000-0000-4000-800000000001' as Note['id'],
    notebookId: NB,
    title: 'Test note',
    properties: {},
    body: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    syncStatus: 'synced',
    ...overrides,
  } as ClientNote;
}

afterEach(() => {
  // RTL cleanup — unmount components so renders don't accumulate across tests.
  cleanup();
  // Dismiss any toasts left over from a test to keep module singleton state clean.
  for (const t of getToasts()) {
    dismissToast(t.id);
  }
});

// ── ToastHost ────────────────────────────────────────────────────────────────

describe('CAV-8 — conflict toast', () => {
  it('renders nothing before any toast is shown', () => {
    const { container } = renderWithProviders(<ToastHost />);
    expect(container.querySelector('.toast-host')).toBeNull();
  });

  it('renders the spec-exact conflict message after showConflictToast()', async () => {
    renderWithProviders(<ToastHost />);
    showConflictToast('note-cav8-id', 'My conflicted note');
    await waitFor(() =>
      expect(
        screen.getByText(
          /Sync conflict on "My conflicted note" — your version was kept\./i,
        ),
      ).toBeDefined(),
    );
  });

  it('toast has a dismiss button', async () => {
    renderWithProviders(<ToastHost />);
    showConflictToast('note-cav8-id', 'Some note');
    await waitFor(() =>
      expect(screen.getByLabelText('Dismiss')).toBeDefined(),
    );
  });

  it('dismissing removes the toast from the DOM', async () => {
    renderWithProviders(<ToastHost />);
    showConflictToast('note-cav8-id', 'Dismissed note');
    const btn = await waitFor(() => screen.getByLabelText('Dismiss'));
    btn.click();
    await waitFor(() =>
      expect(
        screen.queryByText(/Sync conflict on "Dismissed note"/i),
      ).toBeNull(),
    );
  });

  it('multiple toasts render independently', async () => {
    renderWithProviders(<ToastHost />);
    showConflictToast('note-a', 'Note Alpha');
    showConflictToast('note-b', 'Note Beta');
    await waitFor(() => {
      expect(screen.getByText(/Note Alpha/i)).toBeDefined();
      expect(screen.getByText(/Note Beta/i)).toBeDefined();
    });
  });
});

// ── ConflictBadgeSlot ────────────────────────────────────────────────────────

describe('CAV-8 — persistent conflict badge', () => {
  it('renders no badge when hasConflict is absent', () => {
    const note = makeNote();
    const { container } = renderWithProviders(<ConflictBadgeSlot note={note} />);
    expect(container.querySelector('.conflict-badge')).toBeNull();
  });

  it('renders no badge when hasConflict is false', () => {
    const note = makeNote({ hasConflict: false });
    const { container } = renderWithProviders(<ConflictBadgeSlot note={note} />);
    expect(container.querySelector('.conflict-badge')).toBeNull();
  });

  it('renders the conflict badge when hasConflict is true', () => {
    const note = makeNote({ hasConflict: true });
    const { container } = renderWithProviders(<ConflictBadgeSlot note={note} />);
    expect(container.querySelector('.conflict-badge')).not.toBeNull();
  });

  it('badge has an accessible label', () => {
    const note = makeNote({ hasConflict: true });
    const { container } = renderWithProviders(<ConflictBadgeSlot note={note} />);
    expect(within(container).getByLabelText(/sync conflict/i)).toBeDefined();
  });

  it('badge is interactive (has onClick) when hasConflict is true', () => {
    const note = makeNote({ hasConflict: true, id: 'note-navi-test' as Note['id'] });
    const { container } = renderWithProviders(<ConflictBadgeSlot note={note} />);
    const badge = container.querySelector('.conflict-badge');
    expect(badge?.getAttribute('role')).toBe('button');
  });
});
