/**
 * Entry for the SEPARATE OAuth authorization surface (oauth-consent-surface-separation.md / DEC-0005).
 *
 * Mounts ONLY the self-contained consent flow — NOT the notes App / router / boot store — and, crucially,
 * does NOT register the service worker. The notes SW controls scope '/', but its NavigationRoute denylist
 * (sw.ts) excludes /oauth/, so a navigation here always reaches the network; the worker serves oauth.html
 * with `Cache-Control: no-store` (routes/oauth.ts + wrangler run_worker_first). Net: this surface can never
 * be served stale and never shares the editor's shell-fork/router coupling that the PWA-mediated consent hit.
 *
 * Theme: the Ember default axes are set statically on <html> (oauth.html) and tokens.css supplies the
 * mode-aware palette — a consistent look with NO dependency on the app's themeStore / IndexedDB.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OAuthApp } from './OAuthApp.js';
import '../theme/tokens.css';
import './oauth.css';

const rootEl = document.getElementById('oauth-root');
if (!rootEl) throw new Error('missing #oauth-root');

createRoot(rootEl).render(
  <StrictMode>
    <OAuthApp />
  </StrictMode>,
);
