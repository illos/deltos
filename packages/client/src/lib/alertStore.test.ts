import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Alert } from '@deltos/shared';
import {
  setServerAlerts,
  showAlert,
  removeAlert,
  dismissAlert,
  subscribeAlerts,
  currentAlerts,
  __resetAlertStore,
} from './alertStore.js';

/**
 * alertStore — the client's durable alert store (alert-banner-system.md §4). Asserts the three behaviours the
 * design hinges on: (1) server alerts are a PROJECTION replaced wholesale each pull; (2) session-local dismiss
 * hides an alert without touching the server; (3) the merged list is de-duped + ordered
 * (severity → actionable → recency). Mirrors the toastEvents pub/sub contract (subscribe fires immediately).
 */

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: over.id ?? 'a1',
    kind: over.kind ?? 'agent.writeApproval',
    severity: over.severity ?? 'info',
    source: over.source ?? 'server',
    title: over.title ?? 'Title',
    message: over.message ?? 'Message',
    createdAt: over.createdAt ?? 1000,
    dismissible: over.dismissible ?? true,
    expiresAt: over.expiresAt ?? null,
    actions: over.actions ?? [],
    targetKind: over.targetKind ?? null,
    targetId: over.targetId ?? null,
  };
}

beforeEach(() => { __resetAlertStore(); });

describe('alertStore projection (server set replaced wholesale)', () => {
  it('setServerAlerts REPLACES the server set — a dropped alert stops appearing on the next pull', () => {
    setServerAlerts([mkAlert({ id: 's1' }), mkAlert({ id: 's2' })]);
    expect(currentAlerts().map((a) => a.id).sort()).toEqual(['s1', 's2']);
    // Next pull returns only s2 → s1 must be gone (no merge/accumulation).
    setServerAlerts([mkAlert({ id: 's2' })]);
    expect(currentAlerts().map((a) => a.id)).toEqual(['s2']);
  });

  it('tolerates an absent/empty array (old server) without throwing → clears the server set', () => {
    setServerAlerts([mkAlert({ id: 's1' })]);
    expect(() => setServerAlerts(undefined)).not.toThrow();
    expect(currentAlerts()).toHaveLength(0);
    expect(() => setServerAlerts(null)).not.toThrow();
    expect(currentAlerts()).toHaveLength(0);
  });

  it('aggregates server + local; a shared id de-dupes (server wins)', () => {
    showAlert(mkAlert({ id: 'x', source: 'client', title: 'local' }));
    setServerAlerts([mkAlert({ id: 'x', source: 'server', title: 'server' })]);
    const list = currentAlerts();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe('server');
  });
});

describe('alertStore session-local dismiss', () => {
  it('dismissAlert hides an alert client-side; it does NOT re-appear from the same server set', () => {
    setServerAlerts([mkAlert({ id: 's1' }), mkAlert({ id: 's2' })]);
    dismissAlert('s1');
    expect(currentAlerts().map((a) => a.id)).toEqual(['s2']);
    // A fresh pull still carrying s1 keeps it hidden this session (dismissal is session-local).
    setServerAlerts([mkAlert({ id: 's1' }), mkAlert({ id: 's2' })]);
    expect(currentAlerts().map((a) => a.id)).toEqual(['s2']);
  });

  it('removeAlert drops a local alert (producer clear, distinct from user dismiss)', () => {
    showAlert(mkAlert({ id: 'L', source: 'client' }));
    expect(currentAlerts()).toHaveLength(1);
    removeAlert('L');
    expect(currentAlerts()).toHaveLength(0);
  });
});

describe('alertStore ordering (severity → actionable → recency)', () => {
  it('sorts critical > warning > info, then actionable out-ranks passive, then newest first', () => {
    setServerAlerts([
      mkAlert({ id: 'info-old', severity: 'info', createdAt: 1 }),
      mkAlert({ id: 'warn-passive', severity: 'warning', createdAt: 2, actions: [] }),
      mkAlert({ id: 'warn-actionable', severity: 'warning', createdAt: 3, actions: [{ id: 'approve', label: 'Approve', style: 'primary' }] }),
      mkAlert({ id: 'crit', severity: 'critical', createdAt: 4 }),
    ]);
    expect(currentAlerts().map((a) => a.id)).toEqual(['crit', 'warn-actionable', 'warn-passive', 'info-old']);
  });
});

describe('alertStore subscription (mirrors toastEvents)', () => {
  it('subscribe fires immediately with the current snapshot and again on change; unsubscribe stops it', () => {
    const seen: number[] = [];
    const unsub = subscribeAlerts((a) => seen.push(a.length));
    expect(seen).toEqual([0]); // immediate fire with the (empty) snapshot
    setServerAlerts([mkAlert({ id: 's1' })]);
    expect(seen).toEqual([0, 1]);
    unsub();
    setServerAlerts([mkAlert({ id: 's2' }), mkAlert({ id: 's3' })]);
    expect(seen).toEqual([0, 1]); // no further notifications after unsubscribe
  });

  it('subscribe returns an unsubscribe fn (Set-based, like toastEvents)', () => {
    const fn = vi.fn();
    const unsub = subscribeAlerts(fn);
    expect(typeof unsub).toBe('function');
    unsub();
  });
});
