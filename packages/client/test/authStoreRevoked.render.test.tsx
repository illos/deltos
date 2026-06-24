/**
 * #89 (secSys Leg 2) — ONLINE + revoked/expired cookie (a genuine /refresh 401), DISTINCT from the #85
 * offline-throw path. With a resident account → open the LOCAL shell in a 'signed-out, resume sync' mode
 * (sync hard-gated, full re-login to resume), NOT a hard login-kick and NOT the auto-resuming offline mode.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../src/auth/store.js';
import { SessionStatus } from '../src/components/SessionStatus.js';
import { resumeSync } from '../src/lib/syncEngine.js';
import { db } from '../src/db/schema.js';

const RESIDENT = 'acct-resident';
const resp = (status: number) => new Response(status === 200 ? '{}' : '', { status });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({
    isAuthed: null, isAuthing: false, sessionState: 'booting',
    accountId: null, bearerToken: null, recoveryEstablished: null,
  });
});
afterEach(() => { cleanup(); resumeSync(); vi.restoreAllMocks(); }); // un-gate the engine init() suspended

describe('#89 init() — online + revoked cookie (genuine 401)', () => {
  it('401 + RESIDENT → DISTINCT revoked shell (local shell, gated sync, NOT a login-kick)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    global.fetch = vi.fn(async () => resp(401)) as typeof fetch;
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(s.isAuthed).toBe(true);          // shell opens (NOT the auth-gate)
    expect(s.sessionState).toBe('revoked'); // distinct from 'offline'
    expect(s.accountId).toBe(RESIDENT);
    expect(s.bearerToken).toBeNull();       // sync gated by the absent bearer
    expect(s.recoveryEstablished).toBe(true);
  });

  it('401 + NO resident → auth-gate (true first-setup / new device → full login)', async () => {
    global.fetch = vi.fn(async () => resp(401)) as typeof fetch;
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(s.isAuthed).toBe(false);
    expect(s.sessionState).toBe('unauthed');
  });

  it('OFFLINE throw + resident → still OFFLINE (auto-resume), NOT revoked — modes stay distinct (#85 unchanged)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    global.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().sessionState).toBe('offline');
  });

  it('non-401 error (500) + resident → auth-gate (revoked path is 401-only)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    global.fetch = vi.fn(async () => resp(500)) as typeof fetch;
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().sessionState).toBe('unauthed');
  });

  it('401 during a LIVE ceremony (isAuthing) → does not flip isAuthed (the ceremony owns the gate)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    useAuthStore.setState({ isAuthing: true, isAuthed: null });
    global.fetch = vi.fn(async () => resp(401)) as typeof fetch;
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().isAuthed).toBeNull();
  });
});

describe('#89 SessionStatus — the distinct degraded modes', () => {
  const renderFor = (sessionState: string) => {
    useAuthStore.setState({ sessionState: sessionState as never });
    return render(<MemoryRouter><SessionStatus /></MemoryRouter>);
  };

  it('revoked → a DISTINCT "Signed out — sign in to resume sync" nudge', () => {
    expect(renderFor('revoked').container.textContent).toContain('Signed out — sign in to resume sync');
  });

  it('offline → renders nothing here (SyncIndicator shows it; auto-resume, no sign-in nudge)', () => {
    expect(renderFor('offline').container.textContent).toBe('');
  });

  it('unauthed → the existing "Sign in to sync" nudge', () => {
    expect(renderFor('unauthed').container.textContent).toContain('Sign in to sync');
  });

  it('active → nothing', () => {
    expect(renderFor('active').container.textContent).toBe('');
  });
});
