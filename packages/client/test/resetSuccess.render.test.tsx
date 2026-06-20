/**
 * Render tests for the reset route: success-state bug (#51) + 2FA disclosure (#56).
 *
 * RR-1  reset 200 + finalize ok  → navigates away (no error, no done)
 * RR-2  reset 200 + finalize 503 → shows 'Password reset' done state (NOT 'Connection error')
 * RR-3  reset 200 + finalize throws → same done state (NOT 'Connection error')
 * RR-4  reset failure             → shows form error, stays on reset form
 * RR-5  2FA disclosure is present on the form BEFORE submit (#56 gate)
 * RR-6  2FA echo appears on the success screen (#56 optional — keeps the promise visible post-reset)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { screen } from './renderHelpers.js';
import { MemoryRouter } from 'react-router-dom';
import { ResetRoute } from '../src/routes/ResetRoute.js';
import { useAuthStore } from '../src/auth/store.js';

// ── Shared store setup ────────────────────────────────────────────────────────

function setupStore(opts: {
  resetResult: { ok: true } | { ok: false; code: 'invalid' | 'rate_limited' | 'network' };
  finalizeResult?: { ok: true } | { ok: false } | 'throw';
}) {
  useAuthStore.setState({
    isAuthed: false,
    isAuthing: false,
    bearerToken: null,
    accountId: null,
    username: null,
    recoveryEstablished: null,
    sessionState: 'unauthed',
    error: null,
    beginAuth: vi.fn(() => { useAuthStore.setState({ isAuthing: true }); }),
    finalizeAuth: opts.finalizeResult === 'throw'
      ? vi.fn(async () => { throw new Error('503'); })
      : vi.fn(async () => {
          if (!opts.finalizeResult || opts.finalizeResult.ok) {
            useAuthStore.setState({ isAuthed: true, isAuthing: false, sessionState: 'active' as const });
            return { ok: true } as const;
          }
          return { ok: false } as const;
        }),
    resetWithPhrase: vi.fn(async () => opts.resetResult),
    // Stubs for unused actions
    init: vi.fn(async () => {}),
    login: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    register: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    logout: vi.fn(async () => {}),
    establishRecovery: vi.fn(async () => ({ ok: false } as const)),
    setupTotp: vi.fn(async () => ({ ok: false, code: 'invalid' } as const)),
    verifyTotp: vi.fn(async () => ({ ok: false } as const)),
    clearError: vi.fn(),
  } as Parameters<typeof useAuthStore.setState>[0]);
}

function mountReset() {
  render(
    <MemoryRouter initialEntries={['/reset']}>
      <ResetRoute />
    </MemoryRouter>,
  );
}

/** Fill in all reset form fields and click Reset password. */
async function fillAndSubmit() {
  const usernameInput = document.querySelector('input[aria-label="Username"]') as HTMLInputElement;
  const phraseInput = document.querySelector('textarea[aria-label="Recovery phrase"]') as HTMLTextAreaElement;
  const pwInput = document.querySelector('input[aria-label="New password"]') as HTMLInputElement;
  const confirmInput = document.querySelector('input[aria-label="Confirm new password"]') as HTMLInputElement;

  fireEvent.change(usernameInput, { target: { value: 'alice' } });
  fireEvent.change(phraseInput, { target: { value: 'a b c d e f g h i j k l m n o p q r s t u v w x' } });
  fireEvent.change(pwInput, { target: { value: 'newpassword1' } });
  fireEvent.change(confirmInput, { target: { value: 'newpassword1' } });

  const btn = document.querySelector('button.auth__btn--primary') as HTMLButtonElement;
  fireEvent.click(btn);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
});

// ── RR-1: reset 200 + finalize ok ─────────────────────────────────────────────

describe('RR-1 — reset 200 + finalize ok → shell (no error, no done)', () => {
  it('does not show error or done state when both calls succeed', async () => {
    setupStore({ resetResult: { ok: true }, finalizeResult: { ok: true } });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });
    await fillAndSubmit();

    // Busy state appears
    await waitFor(() => {
      expect(document.querySelector('.auth__spinner')).not.toBeNull();
    });

    // After finalize succeeds, busy resolves — no error, no 'Password reset' done heading
    await waitFor(() => {
      expect(screen.queryByText('Connection error — please try again')).toBeNull();
      expect(screen.queryByRole('heading', { name: /Password reset/i })).toBeNull();
    });
  });
});

// ── RR-2: reset 200 + finalize 503 (returns ok:false) ────────────────────────

describe('RR-2 — reset 200 + finalize 503 → done state, NOT connection error', () => {
  it('shows Password reset done heading when finalize returns ok:false', async () => {
    setupStore({ resetResult: { ok: true }, finalizeResult: { ok: false } });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });
    await fillAndSubmit();

    // Must show the done state
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Password reset/i })).not.toBeNull();
    });

    // Must NOT show 'Connection error'
    expect(screen.queryByText('Connection error — please try again')).toBeNull();

    // Must show 'Sign in' CTA
    expect(screen.queryByRole('button', { name: /Sign in/i })).not.toBeNull();
  });
});

// ── RR-3: reset 200 + finalize throws ────────────────────────────────────────

describe('RR-3 — reset 200 + finalize throws → done state, NOT connection error', () => {
  it('shows Password reset done heading when finalize throws', async () => {
    setupStore({ resetResult: { ok: true }, finalizeResult: 'throw' });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });
    await fillAndSubmit();

    // Done state — not error
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Password reset/i })).not.toBeNull();
    });

    expect(screen.queryByText('Connection error — please try again')).toBeNull();
  });
});

// ── RR-4: reset failure → form error ─────────────────────────────────────────

describe('RR-4 — reset failure → shows form error, stays on form', () => {
  it('shows form error when resetWithPhrase returns invalid', async () => {
    setupStore({ resetResult: { ok: false, code: 'invalid' } });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });
    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.queryByText('Incorrect details — please check your recovery phrase')).not.toBeNull();
    });

    // No done state
    expect(screen.queryByRole('heading', { name: /Password reset/i })).toBeNull();
  });
});

// ── RR-5: 2FA disclosure on the reset form (#56 gate) ────────────────────────

describe('RR-5 — 2FA disclosure is present on the reset form before submit', () => {
  it('shows a two-factor disclosure in the reset form', async () => {
    setupStore({ resetResult: { ok: false, code: 'invalid' } });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });

    // The 2FA disclosure must be visible before the user submits anything (#56).
    // /reset runs disableTotp() by design — the user must not lose 2FA silently.
    expect(document.body.textContent).toMatch(/two-factor/i);
    expect(document.body.textContent).toMatch(/Settings/i);
  });
});

// ── RR-6: 2FA echo on the success screen (#56 optional) ──────────────────────

describe('RR-6 — 2FA echo appears on the reset success screen', () => {
  it('shows the 2FA-off reminder on the done state', async () => {
    setupStore({ resetResult: { ok: true }, finalizeResult: { ok: false } });
    mountReset();

    await screen.findByRole('heading', { name: /Reset your password/i });
    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Password reset/i })).not.toBeNull();
    });

    expect(document.body.textContent).toMatch(/Two-factor authentication has been turned off/i);
  });
});
