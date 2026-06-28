/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

// The plugin injects the precache manifest here at build time.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// INSTALL-AND-WAIT by default (pwa-force-update). A freshly-installed worker does NOT
// self.skipWaiting() and does NOT clientsClaim() — so an installed app NEVER auto-swaps the
// running build on launch/reload. The running build only changes when the user explicitly taps
// "Update now" in Settings, which posts the SKIP_WAITING message handled below. The precache /
// runtime caching strategy is deliberately unchanged — this only governs WHEN a waiting worker
// activates, never WHAT is cached.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    // Runs ONLY in response to the manual "Update now" control — never automatically.
    void self.skipWaiting();
  }
});

// Precache the app shell so launch never depends on the network — the basis of both the
// near-native cold start and offline boot.
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback: serve the precached shell for in-app navigations so any route
// renders offline.
//
// DENYLIST — load-bearing. A direct navigation to an `/api/*` URL (a download, a signed link,
// an `<a href>`) must reach the worker and get the real response, NEVER the cached shell. SPA
// fetch/XHR calls aren't navigations and were always fine; this only bites direct navigations,
// which is precisely the case the denylist excludes. Drop this line and API navigations
// silently return HTML.
const shellHandler = createHandlerBoundToURL('index.html');
registerRoute(new NavigationRoute(shellHandler, { denylist: [/^\/api\//] }));

// FONTS — permanent device cache (UI refresh, Lane 0). The everyday faces (Plex Sans + Plex Mono)
// are PRECACHED via the manifest (woff2 in the injectManifest glob), so they're install-time and
// offline-ready. This runtime rule is CacheFirst with NO expiration, so any /fonts/ asset NOT in the
// precache — the lazy voice faces fetched on first Appearance selection (Lane 5) — is stored once and
// served from cache forever after, across deploys. Scoped strictly to /fonts/ (own cache bucket),
// so it never touches /api or the shell (pin-storage-1-sw-cache-invariant).
registerRoute(
  ({ url }) => url.pathname.startsWith('/fonts/'),
  new CacheFirst({ cacheName: 'deltos-fonts' }),
);

// PDF.js ENGINE CHUNKS — runtime-cached so a second PDF open (incl. offline) needs no network for the engine
// (pdf-reader.md §6.2). These are FIRST-PARTY app-asset JS chunks, modeled exactly on the /fonts/ rule above.
// They are deliberately kept OUT of the install precache (vite.config.ts globIgnores), so this rule caches
// them lazily on first PDF open. CacheFirst + no expiration = stored once, served forever across this deploy;
// a new deploy hashes new filenames → new entries, old ones idle out (same lifecycle as the fonts rule).
//
// PIN-STORAGE-1 (pin-storage-1-sw-cache-invariant) — the predicate is scoped to BOTH same-origin AND the
// pdf.js chunk-name prefixes (`/assets/pdfjs-*.js`, `/assets/pdf.worker*.js`). An `/api/*` path can satisfy
// NEITHER, so the PDF blob bytes (GET /api/plugin/blob/:hash) match no caching strategy and are NEVER written
// to Cache Storage. No `/api` response ever reaches a caching strategy in this file (grep-auditable).
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    (/^\/assets\/pdfjs-.*\.js$/.test(url.pathname) || /^\/assets\/pdf\.worker.*\.js$/.test(url.pathname)),
  new CacheFirst({ cacheName: 'deltos-pdfjs' }),
);
