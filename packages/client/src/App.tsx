import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { NewNote } from './routes/NewNote.js';
import { NoteRoute } from './routes/NoteRoute.js';
import { EnrollRoute } from './routes/EnrollRoute.js';
import { UnlockRoute } from './routes/UnlockRoute.js';
import { RecoverRoute } from './routes/RecoverRoute.js';
import { QrReceiveRoute } from './routes/QrReceiveRoute.js';
import { startSyncTriggers, syncNow } from './lib/syncEngine.js';
import { getDefaultNotebookId } from './lib/notebooks.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { SessionStatus } from './components/SessionStatus.js';
import { ConflictToastHostSlot } from './components/ConflictToastHostSlot.js';
import { ConflictBadgeSlot } from './components/ConflictBadgeSlot.js';
import { useAuthStore } from './auth/store.js';
import { selectBootView } from './auth/shellGate.js';
import { useNotes } from './db/storeHooks.js';

/**
 * App shell — the local-first host chrome that every surface mounts inside (spec Part 1a).
 *
 * LOCAL-FIRST, AUTH IN THE BACKGROUND. The shell renders notes from the local store immediately;
 * auth + sync are demoted to a background concern that never blocks launch:
 *   - `init()` reads only the LOCAL durable identity (isEnrolled + keyId from IndexedDB, no network),
 *     then kicks a background session re-mint it does NOT await — so the shell paints before any
 *     auth round-trip (render-before-data).
 *   - The boot view is chosen purely by {@link selectBootView}(isEnrolled, enrolling): a local key
 *     present → the notes shell, regardless of session/unlock state; no local key → the ONE blocking
 *     gate (enroll, with recover / QR links). Session/unlock state never gates the UI. The `enrolling`
 *     latch pins the enroll surface through a live ceremony so the gate can't short-circuit it.
 *   - A failed / pending background session is a quiet, non-blocking nudge ({@link SessionStatus}),
 *     never an eviction to a recovery screen. This is what closes E4 properly — there is no
 *     "device hasn't been registered" boot gate; it survives only as the no-local-key recovery path.
 *
 * Routing uses BrowserRouter (history API). The service worker's SPA navigation fallback serves
 * index.html for all in-scope navigations, so direct loads of /note/:id work offline. Auth routes
 * (/enroll, /unlock, /recover, /qr-receive) are served the same way.
 *
 * PIN-ID-9 note: WebAuthn create()/get() must fire as the FIRST await in a user gesture. All button
 * handlers in EnrollRoute / UnlockRoute / RecoverRoute / QrReceiveRoute are synchronous — they call
 * the store action immediately, with no preceding await.
 */
export function App() {
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function AppRoutes() {
  const isEnrolled = useAuthStore((s) => s.isEnrolled);
  // A live enroll/recover/QR ceremony pins the enroll surface end-to-end (shellGate) so the gate
  // can't unmount it after the credential is created but before the phrase is shown + the device is
  // registered + a session is minted (the P0 mid-ceremony-unmount bug).
  const enrolling = useAuthStore((s) => s.enrolling);

  switch (selectBootView(isEnrolled, enrolling)) {
    // Boot: the ONLY thing gating first paint is the LOCAL durable-identity read (no network, works
    // offline). The static index.html skeleton has already painted; this is a brief neutral hold.
    case 'boot':
      return (
        <div className="auth">
          <div className="auth__spinner" aria-label="Loading" />
        </div>
      );

    // No local key — genuine first-run OR the user cleared browsing data → the ONE blocking gate:
    // enroll, with recover / QR-join links. This is the only logout path (spec Part 1a §Behavior 4).
    case 'enroll-gate':
      return (
        <Routes>
          <Route path="/enroll" element={<EnrollRoute />} />
          <Route path="/recover" element={<RecoverRoute />} />
          <Route path="/qr-receive" element={<QrReceiveRoute />} />
          <Route path="*" element={<Navigate to="/enroll" replace />} />
        </Routes>
      );

    // Local identity present → render the notes shell immediately, regardless of session/unlock
    // state. Auth + sync run in the background underneath it.
    case 'shell':
      return <AuthedShell />;
  }
}

function HomeView() {
  const notes = useNotes(getDefaultNotebookId());
  return (
    <div className="home">
      <div className="home__header">
        <span className="home__title">Notes</span>
        <Link to="/new" className="home__new-btn">+ New</Link>
      </div>
      {notes.length === 0 ? (
        <p className="home__lede">No notes yet.</p>
      ) : (
        <ul className="home__notes">
          {notes.map(note => (
            <li key={note.id}>
              <Link to={`/note/${note.id}`} className="home__note-link">
                {note.title || 'Untitled'}
              </Link>
              {/* Part 2 slot: gruntSys2's conflict badge renders here off note.hasConflict. */}
              <ConflictBadgeSlot note={note} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AuthedShell() {
  const sessionState = useAuthStore((s) => s.sessionState);

  useEffect(() => {
    return startSyncTriggers(getDefaultNotebookId());
  }, []);

  // When the background session goes live (e.g. after a gesture-unlock from the nudge), drain the
  // queue immediately rather than waiting for the 30s poll. syncNow is single-flight-guarded, so the
  // StrictMode double-invoke and concurrent triggers collapse to one push.
  useEffect(() => {
    if (sessionState === 'active') syncNow(getDefaultNotebookId());
  }, [sessionState]);

  return (
    <div className="shell">
      <header className="shell__bar">
        <Link to="/" className="shell__mark">δ deltos</Link>
        <SessionStatus />
        <SyncIndicator />
      </header>

      <main className="shell__main">
        <Routes>
          <Route path="/new" element={<NewNote />} />
          <Route path="/note/:id" element={<NoteRoute />} />
          <Route path="/" element={<HomeView />} />
          {/* Reachable, NOT forced — the SessionStatus nudge routes here for the unlock gesture;
              recover / QR-join remain available to an already-enrolled device (e.g. adding a key). */}
          <Route path="/unlock" element={<UnlockRoute />} />
          <Route path="/recover" element={<RecoverRoute />} />
          <Route path="/qr-receive" element={<QrReceiveRoute />} />
          {/* Already enrolled: a fresh-account enroll is meaningless here — send home. */}
          <Route path="/enroll" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* TOAST-HOST MOUNT SLOT — gruntSys2 fills this with the conflict ToastHost for Part 2.
          Leave the slot; do not build the toast here. */}
      <ConflictToastHostSlot />
    </div>
  );
}
