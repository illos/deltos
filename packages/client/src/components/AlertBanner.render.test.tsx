import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import type { Alert } from '@deltos/shared';

/**
 * AlertBanner — the top-of-shell alert strip (alert-banner-system.md §5, standing ui-features-need-rendered-ui
 * gate). Mounts the REAL banner driven by the REAL alertStore and asserts the rendered contract:
 *   (a) it renders an actionable alert from the store (title + message + Approve/Deny),
 *   (b) tapping "Review" opens the lazy ApprovalSheet,
 *   (c) an inline Approve fires the POST with the right actionId (alertsClient.actOnAlert),
 *   (d) a passive dismissible alert renders a × that removes it,
 *   (e) null-render when the store is empty (off-first-load posture).
 * The REST client is mocked so no network is touched; the store is the real module (reset per test).
 */

const { actOnAlert, AlertActionError } = vi.hoisted(() => {
  class AlertActionError extends Error {
    status: number | undefined; alreadyResolved: boolean;
    constructor(msg: string, status?: number, alreadyResolved = false) { super(msg); this.status = status; this.alreadyResolved = alreadyResolved; }
  }
  return { actOnAlert: vi.fn(async () => ({ id: 'ap-1', status: 'approved' as const, grantedCount: 430 })), AlertActionError };
});
vi.mock('../lib/alertsClient.js', () => ({ actOnAlert, AlertActionError }));

import { AlertBanner } from './AlertBanner.js';
import { setServerAlerts, __resetAlertStore } from '../lib/alertStore.js';

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'ap-1', kind: 'agent.writeApproval', severity: 'warning', source: 'server',
    title: 'This agent wants to make ~430 writes', message: 'Bulk import from calendar',
    createdAt: 1000, dismissible: true, expiresAt: null,
    actions: [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
    targetKind: 'writeApproval', targetId: 'wa-1', ...over,
  };
}

beforeEach(() => { __resetAlertStore(); actOnAlert.mockClear(); });
afterEach(cleanup);

describe('AlertBanner', () => {
  it('renders null when the store is empty (off-first-load posture)', () => {
    const { container } = render(<AlertBanner />);
    expect(container.querySelector('.alert-banner')).toBeNull();
  });

  it('(a) renders an actionable alert from the store — title, message, Approve + Deny', () => {
    const { getByText, container } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert()]); });
    expect(container.querySelector('.alert-banner')).not.toBeNull();
    expect(getByText('This agent wants to make ~430 writes')).not.toBeNull();
    expect(getByText('Bulk import from calendar')).not.toBeNull();
    expect(getByText('Approve')).not.toBeNull();
    expect(getByText('Deny')).not.toBeNull();
  });

  it('(b) tapping Review opens the lazy ApprovalSheet (role=dialog)', async () => {
    const { getByText, findByRole } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert()]); });
    fireEvent.click(getByText('Review'));
    const dialog = await findByRole('dialog'); // ApprovalSheet is React.lazy → resolves async
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-label')).toBe('Review request');
  });

  it('(c) inline Approve fires the POST with actionId "approve"', async () => {
    const { getByText } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert()]); });
    fireEvent.click(getByText('Approve'));
    await waitFor(() => expect(actOnAlert).toHaveBeenCalledTimes(1));
    expect(actOnAlert).toHaveBeenCalledWith('ap-1', 'approve');
  });

  it('inline Deny fires the POST with actionId "deny"', async () => {
    const { getByText } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert()]); });
    fireEvent.click(getByText('Deny'));
    await waitFor(() => expect(actOnAlert).toHaveBeenCalledWith('ap-1', 'deny'));
  });

  it('(d) a passive dismissible alert renders a × that removes it', () => {
    const { getByLabelText, container } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert({ id: 's-1', actions: [], severity: 'warning', kind: 'storage.quota' })]); });
    expect(container.querySelector('.alert-banner')).not.toBeNull();
    fireEvent.click(getByLabelText('Dismiss'));
    expect(container.querySelector('.alert-banner')).toBeNull();
  });

  it('shows a "+N more" affordance when multiple alerts are active', () => {
    const { getByText } = render(<AlertBanner />);
    act(() => { setServerAlerts([mkAlert({ id: 'a' }), mkAlert({ id: 'b', createdAt: 500 })]); });
    expect(getByText('+1 more')).not.toBeNull();
  });
});
