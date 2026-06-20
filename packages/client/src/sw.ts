/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

// The plugin injects the precache manifest here at build time.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Take control as soon as a new SW is ready (paired with registerType: 'autoUpdate') so an
// installed app never lingers on a stale shell.
self.skipWaiting();
clientsClaim();

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
