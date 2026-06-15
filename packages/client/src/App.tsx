import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { NewNote } from './routes/NewNote.js';
import { NoteRoute } from './routes/NoteRoute.js';

/**
 * App shell — the host chrome that every surface mounts inside.
 *
 * Routing uses BrowserRouter (history API). The service worker's SPA navigation fallback
 * serves index.html for all in-scope navigations, so direct loads of /note/:id and /new work
 * offline without a server. The /api/ denylist in sw.ts ensures API navigations reach the
 * worker, not the shell.
 */
export function App() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return (
    <BrowserRouter>
      <div className="shell">
        <header className="shell__bar">
          <Link to="/" className="shell__mark">δ deltos</Link>
          <span
            className={`shell__net shell__net--${online ? 'online' : 'offline'}`}
            title={online ? 'online' : 'offline — running from cache'}
          >
            {online ? 'online' : 'offline'}
          </span>
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
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
