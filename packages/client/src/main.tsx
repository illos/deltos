import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root');

// Mount the app shell. The static skeleton in index.html has already painted; React replaces
// it here, then data (Phase 1) hydrates asynchronously underneath the same chrome.
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker (autoUpdate). Offline auth/data are Phase 1; the SW today only
// precaches the shell so launch and reload work with no network.
registerSW({ immediate: true });
