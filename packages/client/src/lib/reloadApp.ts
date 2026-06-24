/**
 * #101 — hard reload, wrapped in one place so it's a single mock point. (jsdom has no real
 * location.reload, and tests need to assert the reload happens AFTER the flush.) There's no bespoke
 * snap-reload / SW-update helper in the client today; the service worker self-skipWaiting()s, so a plain
 * reload picks up any waiting build. If a dedicated post-deploy reload helper lands later, route it here.
 */
export function reloadApp(): void {
  window.location.reload();
}
