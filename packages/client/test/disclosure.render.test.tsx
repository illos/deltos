/**
 * P1-10 render leg — Disclosure component renders the correct planSys-approved copy.
 *
 * Matrix row: P1-10 "Disclosure at credential-establishment, OUT of the login path"
 * Tier: [CLI-auto: render] (jsdom)
 * Owner: gruntSys2
 *
 * Pass conditions (render sub-leg):
 *   - Disclosure renders the planSys definitive-synthesis title and body verbatim
 *   - Risk clause present (secSys requirement)
 *   - Copy is uniform regardless of prf prop (Option-A collapses the branch)
 *   - children prop overrides the body (custom content path)
 *   - LoginRoute (launch/re-auth path) renders NO .disclosure element (placement enforcement)
 *   - RegisterRoute (credential-establishment path) renders .disclosure at the phrase step
 *
 * Note: under the auth pivot the phrase-role in the disclosure body is a seam for a planSys
 * copy pass (phrase = reset token, not a device-access key). The Disclosure component tests pass
 * against the current planSys-approved copy regardless; that seam is tracked separately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { Disclosure } from '../src/components/Disclosure.js';
import { LoginRoute } from '../src/routes/LoginRoute.js';
import { RegisterRoute } from '../src/routes/RegisterRoute.js';
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

// ── Placement: LoginRoute (re-auth path) must NOT render Disclosure ───────────

describe('P1-10 — Disclosure absent from the login path', () => {
  it('LoginRoute renders no .disclosure element', () => {
    const { container } = renderWithProviders(<LoginRoute />);
    expect(container.querySelector('.disclosure')).toBeNull();
  });
});

// ── B1: Positive placement — Disclosure present at RegisterRoute (establishment path) ────────────
//
// secSys hard requirement: Disclosure must appear at the credential-establishment path (register).
// We drive RegisterRoute to its phrase step via mocked store actions and assert the element.

describe('P1-10 — Disclosure present at credential-establishment path (RegisterRoute)', () => {
  const STUB_PHRASE = Array(24).fill('word').join(' ');

  beforeEach(() => {
    useAuthStore.setState({
      beginAuth: vi.fn(),
      finalizeAuth: vi.fn(),
      register: vi.fn().mockResolvedValue({ ok: true, recoveryPhrase: STUB_PHRASE }),
      setupTotp: vi.fn().mockResolvedValue({ ok: false, code: 'invalid' }),
      verifyTotp: vi.fn().mockResolvedValue({ ok: true }),
    } as Parameters<typeof useAuthStore.setState>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RegisterRoute renders .disclosure at the phrase step', async () => {
    const { container } = renderWithProviders(<RegisterRoute />);
    // Fill username, password, confirm password
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'myuser' } });    // username
    fireEvent.change(inputs[1], { target: { value: 'mypassword123' } }); // password
    fireEvent.change(inputs[2], { target: { value: 'mypassword123' } }); // confirm
    // Click "Create account"
    const btn = container.querySelector('button.auth__btn--primary') as HTMLElement;
    btn.click();
    // Wait for register() to resolve → phrase step → Disclosure mounts
    await waitFor(() =>
      expect(container.querySelector('.disclosure')).not.toBeNull(),
    );
  });
});
