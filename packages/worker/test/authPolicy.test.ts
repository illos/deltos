import { describe, it, expect } from 'vitest';
import { SCOPES } from '@deltos/shared';
import {
  entitlementFor,
  SESSION_GRANT_RESOURCE,
  SESSION_TTL_MS,
  DEVICE_REVOKE_STEP_UP,
} from '../src/authPolicy.js';

/**
 * Auth policy is intentionally small + pinned: the F5 clamp's upper bound, the session grant target,
 * the token lifetime, and the device-revoke step-up binding. These vectors document the v1 policy and
 * catch silent drift (e.g. SCOPES growing should widen the entitlement deliberately, not by accident).
 */

describe('authPolicy', () => {
  it('v1 entitlement is the FULL account scope (a device acts for its own account)', () => {
    expect(entitlementFor({ accountFingerprint: 'acct' })).toEqual([...SCOPES]);
  });
  it('a session grant targets the whole workspace', () => {
    expect(SESSION_GRANT_RESOURCE).toEqual({ kind: 'workspace' });
  });
  it('session TTL is 30 days', () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('device-revoke step-up binds (delete, workspace)', () => {
    expect(DEVICE_REVOKE_STEP_UP).toEqual({ op: 'delete', resource: { kind: 'workspace' } });
  });
});
