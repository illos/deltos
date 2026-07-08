import { describe, it, expect } from 'vitest';
import {
  AlertSchema,
  AlertActionRequestSchema,
  ALERT_KINDS,
  findAlertKind,
  SyncPullResponseSchema,
} from '../src/api/index.js';

/**
 * The GENERIC alert model (alert-banner-system.md §3) — the single schema-first shape a many-producer banner
 * renders. These pin the two load-bearing boundary properties: the alert shape round-trips + fills defaults,
 * and the `alerts` field is ADDITIVE-SAFE on the sync-pull response (an old response with no `alerts` parses,
 * and an unknown field never rejects — so an alert can NEVER 400 a sync batch).
 */
describe('AlertSchema — the generic alert shape', () => {
  it('parses a full actionable alert and preserves its fields', () => {
    const alert = {
      id: 'ap-1', kind: 'agent.writeApproval', severity: 'warning', source: 'server',
      title: 'Agent wants to write more', message: 'This agent wants to make ~430 writes: import',
      createdAt: 1_700_000_000_000, dismissible: false, expiresAt: 1_700_000_030_000,
      actions: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'deny', label: 'Deny', style: 'danger' }],
      targetKind: 'writeApproval', targetId: 'ap-1',
    };
    const parsed = AlertSchema.parse(alert);
    expect(parsed.kind).toBe('agent.writeApproval');
    expect(parsed.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
    expect(parsed.targetId).toBe('ap-1');
  });

  it('fills defaults for a minimal PASSIVE alert (no actions / no target / dismissible / not-expiring)', () => {
    const parsed = AlertSchema.parse({
      id: 'storage.quota', kind: 'storage.quota', severity: 'warning', source: 'server',
      title: 'Storage almost full', message: 'Storage is at 95% of your 10 GB limit.',
      createdAt: 1_700_000_000_000,
    });
    expect(parsed.actions).toEqual([]);
    expect(parsed.dismissible).toBe(true);
    expect(parsed.expiresAt).toBeNull();
    expect(parsed.targetKind).toBeNull();
    expect(parsed.targetId).toBeNull();
  });

  it('an action defaults its style to neutral', () => {
    const parsed = AlertSchema.parse({
      id: 'x', kind: 'k', severity: 'info', source: 'client', title: 't', message: 'm',
      createdAt: 1, actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(parsed.actions[0].style).toBe('neutral');
  });
});

describe('ALERT_KINDS registry — a new kind is a declaration', () => {
  it('declares the actionable agent-approval kind (with its dispatch targetKind) and the passive storage kind', () => {
    const agent = findAlertKind('agent.writeApproval');
    expect(agent?.targetKind).toBe('writeApproval');
    expect(agent?.glyph).toBe('agent');
    const storage = findAlertKind('storage.quota');
    expect(storage?.targetKind).toBeUndefined(); // passive — no server action handler
    expect(ALERT_KINDS.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AlertActionRequestSchema — the client→server action body is STRICT', () => {
  it('accepts a bare actionId and REJECTS unknown fields (validated hard at the write boundary)', () => {
    expect(AlertActionRequestSchema.parse({ actionId: 'approve' }).actionId).toBe('approve');
    expect(AlertActionRequestSchema.safeParse({ actionId: 'approve', extra: 1 }).success).toBe(false);
    expect(AlertActionRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('SyncPullResponse.alerts — additive + safe (can NEVER 400 a sync batch)', () => {
  const base = { notes: [], notebooks: [], dictionaryWords: [], nextCursor: 0, hasMore: false };

  it('an OLD pull response WITHOUT `alerts` still parses → defaults to []', () => {
    const parsed = SyncPullResponseSchema.parse(base);
    expect(parsed.alerts).toEqual([]);
  });

  it('a response WITH alerts parses them', () => {
    const parsed = SyncPullResponseSchema.parse({
      ...base,
      alerts: [{ id: 'a', kind: 'agent.writeApproval', severity: 'warning', source: 'server', title: 't', message: 'm', createdAt: 1 }],
    });
    expect(parsed.alerts).toHaveLength(1);
  });

  it('the response is NOT strict — an UNKNOWN extra field is stripped, never rejected (no 400 on a sync batch)', () => {
    const res = SyncPullResponseSchema.safeParse({ ...base, someFutureField: 42 });
    expect(res.success).toBe(true);
  });
});
