/**
 * P1-10 render leg — Disclosure component renders the correct planSys-approved copy.
 *
 * Matrix row: P1-10 "Disclosure at enroll/recovery, OUT of the launch path"
 * Tier: [CLI-auto: render] (jsdom)
 * Owner: gruntSys2
 *
 * Pass conditions (render sub-leg):
 *   - Disclosure renders the planSys definitive-synthesis title and body verbatim
 *   - Risk clause present (secSys requirement)
 *   - Copy is uniform regardless of prf prop (Option-A collapses the branch)
 *   - children prop overrides the body (custom content path)
 *   - UnlockRoute (launch path) renders NO .disclosure element (placement enforcement)
 *
 * Node-level placement logic (disclosure fires at enroll/recovery, not silent re-auth)
 * is devSys's lane — see shellGate.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import React from 'react';
import { Disclosure } from '../src/components/Disclosure.js';
import { renderWithProviders, screen } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

// Unmount after every test so renders don't accumulate across cases.
afterEach(() => cleanup());

// ── Disclosure component copy ────────────────────────────────────────────────

describe('P1-10 — Disclosure renders correct planSys-approved copy', () => {
  it('renders the approved title', () => {
    renderWithProviders(<Disclosure />);
    expect(screen.getByText(/Your notes on this device/i)).toBeDefined();
  });

  it('renders the main at-rest custody claim', () => {
    renderWithProviders(<Disclosure />);
    expect(screen.getByText(/protected by its lock screen/i)).toBeDefined();
  });

  it('renders the north-star framing — no extra password day-to-day', () => {
    renderWithProviders(<Disclosure />);
    expect(screen.getByText(/no extra password needed day-to-day/i)).toBeDefined();
  });

  it('renders the risk clause (secSys honesty requirement)', () => {
    renderWithProviders(<Disclosure />);
    expect(
      screen.getByText(/anyone who can use it while it is unlocked/i),
    ).toBeDefined();
  });

  it('renders the recovery-phrase exit path', () => {
    renderWithProviders(<Disclosure />);
    expect(screen.getByText(/recovery phrase/i)).toBeDefined();
  });

  it('renders identical copy for prf=true and prf=false (Option-A uniform)', () => {
    const { container: a, unmount: ua } = renderWithProviders(<Disclosure prf={true} />);
    const textA = a.textContent ?? '';
    ua();
    const { container: b } = renderWithProviders(<Disclosure prf={false} />);
    expect(textA).toBe(b.textContent ?? '');
  });

  it('renders children instead of standard body when provided', () => {
    renderWithProviders(<Disclosure>Custom security note</Disclosure>);
    expect(screen.getByText('Custom security note')).toBeDefined();
    expect(screen.queryByText(/protected by its lock screen/i)).toBeNull();
  });

  it('carries the correct accessible role', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const el = container.querySelector('[role="note"]');
    expect(el).not.toBeNull();
  });
});

// ── Placement: UnlockRoute (launch path) must NOT render Disclosure ──────────

describe('P1-10 — Disclosure absent from the launch/unlock path', () => {
  beforeEach(() => {
    // Stub the store to the minimum UnlockRoute needs to render its idle state.
    useAuthStore.setState({
      keyId: 'stub-key-id',
      usesPrf: null,
      justMigratedToDeviceLocal: false,
      unlock: vi.fn(),
      mintSession: vi.fn(),
      register: vi.fn(),
      clearMigrationNotice: vi.fn(),
    } as Parameters<typeof useAuthStore.setState>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UnlockRoute renders no .disclosure element', async () => {
    // Lazy import to avoid importing the real store at module level.
    const { UnlockRoute } = await import('../src/routes/UnlockRoute.js');
    const { container } = renderWithProviders(<UnlockRoute />);
    expect(container.querySelector('.disclosure')).toBeNull();
  });
});
