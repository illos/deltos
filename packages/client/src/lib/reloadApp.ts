/**
 * #101 — hard reload, wrapped in one place so it's a single mock point. (jsdom has no real
 * location.reload, and tests need to assert the reload happens AFTER the flush.) This is a PLAIN
 * reload: under the manual-update posture (pwa-force-update) the SW no longer self-skipWaiting()s, so a
 * plain reload keeps serving the CURRENT build and does NOT pick up a waiting one. Applying a waiting
 * build is the explicit job of the Settings "Update now" control (src/lib/forceUpdate.ts), which posts
 * SKIP_WAITING and then reloads once the new worker activates.
 */
export function reloadApp(): void {
  window.location.reload();
}
