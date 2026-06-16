import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { NewNote } from './routes/NewNote.js';
import { NoteRoute } from './routes/NoteRoute.js';
import { EnrollRoute } from './routes/EnrollRoute.js';
import { UnlockRoute } from './routes/UnlockRoute.js';
import { RecoverRoute } from './routes/RecoverRoute.js';
import { QrReceiveRoute } from './routes/QrReceiveRoute.js';
import { startSyncTriggers } from './lib/syncEngine.js';
import { getDefaultNotebookId } from './lib/notebooks.js';
import { SyncIndicator } from './components/SyncIndicator.js';
import { useAuthStore } from './auth/store.js';

/**
 * App shell — the host chrome that every surface mounts inside.
 *
 * Auth gate: on load, `init()` checks whether a passkey/identity blob exists in IndexedDB.
 *   - Not enrolled → /enroll (first-time setup, recovery, or QR-join links)
 *   - Enrolled but locked → /unlock (passkey ceremony → session mint)
 *   - Enrolled + unlocked → main app shell (notes + sync)
 *
 * Routing uses BrowserRouter (history API). The service worker's SPA navigation fallback
 * serves index.html for all in-scope navigations, so direct loads of /note/:id work offline.
 * Auth routes (/enroll, /unlock, /recover, /qr-receive) are served the same way.
 *
 * PIN-ID-9 note: WebAuthn create()/get() must fire as the FIRST await in a user gesture.
 * All button handlers in EnrollRoute / UnlockRoute / RecoverRoute / QrReceiveRoute are
 * synchronous — they call the store action immediately, with no preceding await.
 */
export function App() {
  const { init } = useAuthStore();

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
  const { isEnrolled, isUnlocked } = useAuthStore();

  // Loading: enrollment check in progress
  if (isEnrolled === null) {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }

  // Auth surface: not enrolled or not unlocked
  if (!isEnrolled || !isUnlocked) {
    return (
      <Routes>
        <Route path="/enroll" element={<EnrollRoute />} />
        <Route path="/recover" element={<RecoverRoute />} />
        <Route path="/qr-receive" element={<QrReceiveRoute />} />
        {isEnrolled
          ? <Route path="*" element={<UnlockRoute />} />
          : <Route path="/unlock" element={<Navigate to="/enroll" replace />} />
        }
        {!isEnrolled && <Route path="*" element={<Navigate to="/enroll" replace />} />}
      </Routes>
    );
  }

  // Authenticated shell — start sync engine once unlocked
  return <AuthedShell />;
}

function AuthedShell() {
  useEffect(() => {
    return startSyncTriggers(getDefaultNotebookId());
  }, []);

  return (
    <div className="shell">
      <header className="shell__bar">
        <Link to="/" className="shell__mark">δ deltos</Link>
        <SyncIndicator />
      </header>

      <main className="shell__main">
        <Routes>
          <Route path="/new" element={<NewNote />} />
          <Route path="/note/:id" element={<NoteRoute />} />
          <Route
            path="/"
            element={
              <div className="home">
                <p className="home__lede">Your notes.</p>
                <Link to="/new" className="home__new-btn">+ New note</Link>
              </div>
            }
          />
          {/* Redirect auth routes back to home when already authenticated */}
          <Route path="/enroll" element={<Navigate to="/" replace />} />
          <Route path="/unlock" element={<Navigate to="/" replace />} />
          <Route path="/recover" element={<Navigate to="/" replace />} />
          <Route path="/qr-receive" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
