/**
 * #85 P0 — offline cold-boot must NOT kick to login. init()'s catch (the /refresh fetch THROWS offline)
 * opens the shell OFFLINE when a resident account marker exists (local Dexie scopes on accountId, no bearer
 * needed); falls to the auth-gate only when there's NO resident (true first-setup). A live ceremony is
 * never disturbed.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../src/auth/store.js';
import { db } from '../src/db/schema.js';

const RESIDENT = 'acct-resident';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({
    isAuthed: null, isAuthing: false, sessionState: 'booting',
    accountId: null, bearerToken: null, recoveryEstablished: null,
  });
  // /refresh THROWS → simulate offline cold boot.
  global.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('#85 init() — offline cold boot', () => {
  it('throw + RESIDENT account present → opens the shell OFFLINE (no login)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(s.isAuthed).toBe(true);          // shell opens (no auth-gate)
    expect(s.sessionState).toBe('offline');
    expect(s.accountId).toBe(RESIDENT);     // local data scopes on this
    expect(s.bearerToken).toBeNull();       // no credential until reconnect re-mints it
    expect(s.recoveryEstablished).toBe(true); // so the gate doesn't divert to the recovery screen
  });

  it('throw + NO resident account → auth-gate (login is correct — true first-setup only)', async () => {
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(s.isAuthed).toBe(false);
    expect(s.sessionState).toBe('offline');
  });

  it('throw during a LIVE ceremony (isAuthing) → does not flip isAuthed (the ceremony owns the gate)', async () => {
    await db.deviceState.put({ key: 'last-account', value: RESIDENT });
    useAuthStore.setState({ isAuthing: true, isAuthed: null });
    await useAuthStore.getState().init();
    const s = useAuthStore.getState();
    expect(s.isAuthing).toBe(true);
    expect(s.isAuthed).toBeNull(); // untouched — init returned early
  });
});
