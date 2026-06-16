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
 *
 * Query strategy: we use container.querySelector('.disclosure__title') / '.disclosure__body'
 * rather than global screen.getByText — the latter matches every ancestor element whose
 * textContent includes the pattern (container, MemoryRouter wrapper, body...), causing
 * multiple-elements-found errors even for a single rendered tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { Disclosure } from '../src/components/Disclosure.js';
import { EnrollRoute } from '../src/routes/EnrollRoute.js';
import { RecoverRoute } from '../src/routes/RecoverRoute.js';
import { QrReceiveRoute } from '../src/routes/QrReceiveRoute.js';
import { renderWithProviders, waitFor } from './renderHelpers.js';
import { useAuthStore } from '../src/auth/store.js';

afterEach(() => cleanup());

// ── Disclosure component copy ────────────────────────────────────────────────

describe('P1-10 — Disclosure renders correct planSys-approved copy', () => {
  it('renders the approved title', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const title = container.querySelector('.disclosure__title');
    expect(title?.textContent).toMatch(/Your notes on this device/i);
  });

  it('renders the main at-rest custody claim', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/protected by its lock screen/i);
  });

  it('renders the north-star framing — no extra password day-to-day', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/no extra password needed day-to-day/i);
  });

  it('renders the risk clause (secSys honesty requirement)', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/anyone who can use it while it is unlocked/i);
  });

  it('renders the recovery-phrase exit path', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/recovery phrase/i);
  });

  it('renders identical copy for prf=true and prf=false (Option-A uniform)', () => {
    const { container: a, unmount: ua } = renderWithProviders(<Disclosure prf={true} />);
    const textA = a.textContent ?? '';
    ua();
    const { container: b } = renderWithProviders(<Disclosure prf={false} />);
    expect(textA).toBe(b.textContent ?? '');
  });

  it('renders children instead of standard body when provided', () => {
    const { container } = renderWithProviders(<Disclosure>Custom security note</Disclosure>);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toBe('Custom security note');
    expect(body?.textContent).not.toMatch(/protected by its lock screen/i);
  });

  it('carries the correct accessible role', () => {
    const { container } = renderWithProviders(<Disclosure />);
    expect(container.querySelector('[role="note"]')).not.toBeNull();
  });
});

// ── Placement: UnlockRoute (launch path) must NOT render Disclosure ──────────

describe('P1-10 — Disclosure absent from the launch/unlock path', () => {
  beforeEach(() => {
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
    const { UnlockRoute } = await import('../src/routes/UnlockRoute.js');
    const { container } = renderWithProviders(<UnlockRoute />);
    expect(container.querySelector('.disclosure')).toBeNull();
  });
});

// ── B1: Positive placement — Disclosure present at every establishment path ───
//
// secSys hard requirement: Disclosure must appear at enroll, recovery, AND QR-join.
// We drive each route to its disclosure step via mocked store actions and assert
// the .disclosure element is present.

describe('P1-10 — Disclosure present at credential-establishment paths', () => {
  const STUB_MNEMONIC = Array(24).fill('word').join(' ');

  beforeEach(() => {
    useAuthStore.setState({
      keyId: 'stub-key-id',
      usesPrf: null,
      justMigratedToDeviceLocal: false,
      enroll: vi.fn().mockResolvedValue({ mnemonic: STUB_MNEMONIC, usesPrf: false }),
      enrollExisting: vi.fn().mockResolvedValue({ usesPrf: false }),
      register: vi.fn().mockResolvedValue(undefined),
      mintSession: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue('ok'),
      claimUsername: vi.fn().mockResolvedValue({ ok: true }),
      clearMigrationNotice: vi.fn(),
    } as Parameters<typeof useAuthStore.setState>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('EnrollRoute renders .disclosure at the mnemonic step', async () => {
    const { container } = renderWithProviders(<EnrollRoute />);
    // "Set up with Passkey" → enroll() resolves → mnemonic step → Disclosure mounts
    const btn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    btn.click();
    await waitFor(() =>
      expect(container.querySelector('.disclosure')).not.toBeNull(),
    );
  });

  it('RecoverRoute renders .disclosure at the disclosure step', async () => {
    const { container } = renderWithProviders(<RecoverRoute />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: STUB_MNEMONIC } });
    const btn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    btn.click();
    await waitFor(() =>
      expect(container.querySelector('.disclosure')).not.toBeNull(),
    );
  });

  it('QrReceiveRoute renders .disclosure after the confirm step', async () => {
    const { container } = renderWithProviders(<QrReceiveRoute />);
    // Step 1: paste mnemonic → "Next" → confirm step
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: STUB_MNEMONIC } });
    const nextBtn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    nextBtn.click();
    // Step 2: "Code confirmed — continue" → enrollExisting() resolves → disclosure step
    await waitFor(() =>
      expect(container.querySelector('.auth__confirm-code')).not.toBeNull(),
    );
    const confirmBtn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    confirmBtn.click();
    await waitFor(() =>
      expect(container.querySelector('.disclosure')).not.toBeNull(),
    );
  });
});

// ── B2: MigrationNotice — renders planSys-approved (B) copy on migrationNotice step ──
//
// secSys requirement: the one-time Option-A migration notice must render the honest
// residual-risk copy approved by planSys and honesty-of-record-checked by secSys.

describe('P1-10 — MigrationNotice renders planSys-approved copy on migration unlock', () => {
  beforeEach(() => {
    useAuthStore.setState({
      keyId: 'stub-key-id',
      usesPrf: null,
      justMigratedToDeviceLocal: true,
      unlock: vi.fn().mockResolvedValue('ok'),
      mintSession: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(undefined),
      clearMigrationNotice: vi.fn(),
    } as Parameters<typeof useAuthStore.setState>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UnlockRoute shows .migration-notice with device-lock custody copy', async () => {
    const { UnlockRoute } = await import('../src/routes/UnlockRoute.js');
    const { container } = renderWithProviders(<UnlockRoute />);
    const unlockBtn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    unlockBtn.click();
    await waitFor(() =>
      expect(container.querySelector('.migration-notice')).not.toBeNull(),
    );
    const body = container.querySelector('.migration-notice__body');
    expect(body?.textContent).toMatch(/how your notes are protected on this device/i);
    expect(body?.textContent).toMatch(/device.s lock screen/i);
    expect(body?.textContent).toMatch(/Your notes and recovery phrase are unchanged/i);
  });
});
