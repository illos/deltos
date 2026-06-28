import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { useThemeStore } from './lib/themeStore.js';
import './theme/tokens.css';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root');

// Apply the persisted appearance theme app-wide (incl. the auth gate), before React mounts. The
// default axes (Ember × Sans × system) are already on <html> statically (index.html) so first paint
// is correct with no flash; this overwrites them from device-local IDB once it resolves.
void useThemeStore.getState().init();

// Mount the app shell. The static skeleton in index.html has already painted; React replaces
// it here, then data (Phase 1) hydrates asynchronously underneath the same chrome.
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker so the shell precaches and launch/reload work with no network.
// Posture is MANUAL ('prompt', not autoUpdate): registerSW installs the worker and checks for a
// new build, but NEVER auto-applies or auto-reloads — a waiting worker is activated only when the
// user taps "Update now" in Settings (src/lib/forceUpdate.ts). We intentionally ignore the
// onNeedRefresh callback here: no banner, no popup, no nag — the Settings control is the sole path.
registerSW({ immediate: true });
