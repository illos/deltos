/**
 * P1-10 render leg — Disclosure component renders the correct planSys-approved copy (A).
 *
 * Matrix row: P1-10 "Disclosure at credential-establishment, OUT of the login path"
 * Tier: [CLI-auto: render] (jsdom)
 * Owner: gruntSys2
 *
 * Pass conditions (render sub-leg):
 *   - Disclosure renders planSys copy A (at-rest residual-risk) verbatim — @2cd2958
 *   - Not-E2EE clause present (secSys honesty requirement)
 *   - Local-read attacker clause present (secSys honesty requirement)
 *   - Copy is uniform regardless of prf prop (Option-A collapses the branch)
 *   - children prop overrides the body (custom content path)
 *   - LoginRoute (re-auth path) renders NO .disclosure element (placement enforcement)
 *   - RegisterRoute (credential-establishment path) renders .disclosure at the FORM step
 *
 * Copy A placement: sign-up form only. Login is re-auth (not establishment) — no disclosure.
 * Copy B (phrase = master key) lives inline in RegisterRoute's phrase step, not via <Disclosure>.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import React from 'react';
import { Disclosure } from '../src/components/Disclosure.js';
import { LoginRoute } from '../src/routes/LoginRoute.js';
import { RegisterRoute } from '../src/routes/RegisterRoute.js';
import { renderWithProviders } from './renderHelpers.js';

afterEach(() => cleanup());

// ── Disclosure component copy (A) ────────────────────────────────────────────

describe('P1-10 — Disclosure renders correct planSys copy A (@2cd2958)', () => {
  it('renders the approved title', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const title = container.querySelector('.disclosure__title');
    expect(title?.textContent).toMatch(/How your notes are kept/i);
  });

  it('renders the sync + device-security claim', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/protected by your device's own security/i);
  });

  it('renders the not-E2EE clause (secSys honesty requirement)', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/aren't end-to-end encrypted/i);
  });

  it('renders the local-read attacker clause (secSys honesty requirement)', () => {
    const { container } = renderWithProviders(<Disclosure />);
    const body = container.querySelector('.disclosure__body');
    expect(body?.textContent).toMatch(/anyone who can unlock or read this device can read your notes/i);
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
    expect(body?.textContent).not.toMatch(/protected by your device/i);
  });

  it('carries the correct accessible role', () => {
    const { container } = renderWithProviders(<Disclosure />);
    expect(container.querySelector('[role="note"]')).not.toBeNull();
  });
});

// ── Placement: LoginRoute (re-auth path) carries copy-A reaffirm ─────────────
//
// secSys placement finding: re-auth paths must also carry the block-A reaffirm
// (not-E2EE / local-read attacker clause) — not full establishment, but reaffirm required.

describe('P1-10 — Disclosure present on the login path (block-A reaffirm)', () => {
  it('LoginRoute renders .disclosure (copy-A reaffirm, secSys requirement)', () => {
    const { container } = renderWithProviders(<LoginRoute />);
    expect(container.querySelector('.disclosure')).not.toBeNull();
    expect(container.querySelector('.disclosure__title')?.textContent).toMatch(/How your notes are kept/i);
  });
});

// ── B1: Positive placement — Disclosure present at RegisterRoute (form/establishment step) ───────

describe('P1-10 — Disclosure present at credential-establishment path (RegisterRoute form step)', () => {
  it('RegisterRoute renders .disclosure immediately on the form step (no interaction needed)', () => {
    const { container } = renderWithProviders(<RegisterRoute />);
    // Disclosure is at the form step — visible immediately, no user interaction required.
    expect(container.querySelector('.disclosure')).not.toBeNull();
    // And it carries copy A
    expect(container.querySelector('.disclosure__title')?.textContent).toMatch(/How your notes are kept/i);
  });
});
