/**
 * ActivitySection render tests (ROAD-0005 P3 — the "Account activity" user-facing audit view).
 *
 * AS-1  renders a human-readable headline + when/where line per event (sign-in, connected-app access)
 * AS-2  a DENY (failed sign-in / blocked) is flagged for the eye ("blocked")
 * AS-3  empty feed → a friendly "No recent activity." (not a spinner forever)
 * AS-4  a load failure surfaces an error + a Retry that re-fetches
 *
 * The network client (auditClient) is mocked — it has its own contract; this test exercises the UI wiring
 * (fetch → describe() → DOM), satisfying the rendered-UI gate (mount the component, assert real DOM).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithProviders, screen, waitFor, userEvent } from './renderHelpers.js';
import type { ActivityEvent } from '../src/lib/auditClient.js';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('../src/lib/auditClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/auditClient.js')>(
    '../src/lib/auditClient.js',
  );
  return { ...actual, listRecentActivity: listMock };
});

function ev(partial: Partial<ActivityEvent> & { id: number; action: string }): ActivityEvent {
  return {
    ts: '2026-06-30T14:00:00.000Z',
    surface: 'auth',
    result: 'allow',
    principalKind: 'owner',
    resourceKind: null,
    resourceId: null,
    ip: null,
    country: null,
    detail: null,
    ...partial,
  };
}

async function mount() {
  const { ActivitySection } = await import('../src/components/ActivitySection.js');
  return renderWithProviders(<ActivitySection />);
}

describe('ActivitySection', () => {
  beforeEach(() => listMock.mockReset());
  afterEach(() => cleanup());

  it('AS-1 renders human-readable headlines + a where line for sign-in and connected-app access', async () => {
    listMock.mockResolvedValue([
      ev({ id: 2, action: 'login', result: 'allow', country: 'US', ip: '203.0.113.7' }),
      ev({ id: 1, action: 'tools/call', surface: 'mcp', principalKind: 'agent', detail: 'get_note' }),
    ]);
    await mount();
    expect(await screen.findByText('Signed in')).toBeDefined();
    // The connected-app (MCP) access reads as plain language with the tool name.
    expect(screen.getByText(/Connected app accessed your notes \(get_note\)/)).toBeDefined();
    // The where line surfaces the location for the sign-in.
    expect(screen.getByText(/US · 203\.0\.113\.7/)).toBeDefined();
  });

  it('AS-2 flags a failed sign-in as blocked', async () => {
    listMock.mockResolvedValue([ev({ id: 1, action: 'login', result: 'deny', detail: 'invalid-credentials' })]);
    await mount();
    expect(await screen.findByText('Failed sign-in attempt')).toBeDefined();
    expect(screen.getByText(/blocked/)).toBeDefined();
  });

  it('AS-3 shows a friendly empty state when there is no activity', async () => {
    listMock.mockResolvedValue([]);
    await mount();
    expect(await screen.findByText('No recent activity.')).toBeDefined();
  });

  it('AS-4 surfaces a load error and Retry re-fetches', async () => {
    const { ActivityError } = await import('../src/lib/auditClient.js');
    listMock.mockRejectedValueOnce(new ActivityError('Your session expired — sign in again to view activity.'));
    await mount();
    expect(await screen.findByText(/session expired/)).toBeDefined();

    listMock.mockResolvedValueOnce([ev({ id: 9, action: 'login', result: 'allow' })]);
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('Signed in')).toBeDefined());
  });
});
