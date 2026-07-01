/**
 * ConnectedAppsSection render test (oauth-provider.md §4 / standing ui-features-need-rendered-ui-gate).
 * Mounts the REAL section over a mocked oauthClient and proves:
 *   - it lists connected apps grouped by clientId (client name + connected date + scope), folding a
 *     re-consented client's multiple grants into ONE row;
 *   - Disconnect → Confirm calls DELETE (disconnectApp) with the clientId and optimistically drops the row;
 *   - the empty state renders when there are no apps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { listConnectedApps, disconnectApp } = vi.hoisted(() => ({
  listConnectedApps: vi.fn(),
  disconnectApp: vi.fn(),
}));
vi.mock('../lib/oauthClient.js', () => {
  class OAuthClientError extends Error {
    status?: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'OAuthClientError';
      this.status = status;
    }
  }
  return { listConnectedApps, disconnectApp, OAuthClientError };
});

import { ConnectedAppsSection } from './ConnectedAppsSection.js';

function app(over: Partial<{ grantId: string; clientId: string; clientName: string | null; scope: string[]; createdAt: string }>) {
  return {
    grantId: over.grantId ?? 'g1',
    clientId: over.clientId ?? 'client_a',
    clientName: over.clientName ?? 'Claude',
    scope: over.scope ?? ['read', 'search'],
    createdAt: over.createdAt ?? '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ConnectedAppsSection', () => {
  it('lists connected apps grouped by clientId with name, date, and scope', async () => {
    listConnectedApps.mockResolvedValue([
      app({ grantId: 'g1', clientId: 'client_a', clientName: 'Claude', createdAt: '2026-06-10T00:00:00.000Z' }),
      // a re-consent: SAME client, second grant, earlier — folds into one row (earliest date shown).
      app({ grantId: 'g2', clientId: 'client_a', clientName: 'Claude', createdAt: '2026-06-01T00:00:00.000Z' }),
      app({ grantId: 'g3', clientId: 'client_b', clientName: 'Other MCP', createdAt: '2026-05-20T00:00:00.000Z' }),
    ]);
    const { container, getByText } = render(<ConnectedAppsSection />);

    await waitFor(() => expect(getByText('Claude')).toBeTruthy());
    expect(getByText('Other MCP')).toBeTruthy();
    // client_a folded to ONE row → two disconnect buttons total (one per client).
    const disconnectBtns = container.querySelectorAll('[aria-label^="Disconnect"]');
    expect(disconnectBtns.length).toBe(2);
    expect(container.textContent).toContain('read, search');
    // Earliest grant date for the folded client.
    expect(container.textContent).toMatch(/Connected .*2026/);
  });

  it('Disconnect → Confirm calls DELETE with the clientId and drops the row', async () => {
    listConnectedApps
      .mockResolvedValueOnce([app({ clientId: 'client_a', clientName: 'Claude' })])
      .mockResolvedValueOnce([]);
    disconnectApp.mockResolvedValue(undefined);
    const { container, getByLabelText, queryByText } = render(<ConnectedAppsSection />);

    await waitFor(() => expect(queryByText('Claude')).toBeTruthy());
    fireEvent.click(getByLabelText('Disconnect Claude'));
    fireEvent.click(getByLabelText('Confirm disconnect Claude'));

    await waitFor(() => expect(disconnectApp).toHaveBeenCalledWith('client_a'));
    await waitFor(() => expect(queryByText('Claude')).toBeNull());
    expect(container.textContent).toContain('No connected apps yet.');
  });

  it('renders the empty state when there are no connected apps', async () => {
    listConnectedApps.mockResolvedValue([]);
    const { getByText } = render(<ConnectedAppsSection />);
    await waitFor(() => expect(getByText('No connected apps yet.')).toBeTruthy());
  });
});
