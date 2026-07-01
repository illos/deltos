/**
 * OAuth consent return-path handoff (oauth-provider.md §2b).
 *
 * When an OAuth client opens `/oauth/authorize?…` on a device with NO live session, the consent route must
 * route the user through the app's NORMAL login and then land them back on the consent screen with the
 * original OAuth params intact — the login ceremony `replace`s history, so the destination can't be carried
 * in the URL. This stashes it in sessionStorage across that one hop; `LoginRoute` consumes it on success and
 * navigates there instead of home. No new auth path — it only redirects where the existing ceremony ends.
 *
 * Session-scoped (not persisted) so it never survives past the tab, and hard-guarded to `/oauth/authorize`
 * paths so a tampered value can only ever bounce to our own consent route — never an open redirect.
 */
const KEY = 'deltos:oauth:return';
const ALLOWED_PREFIX = '/oauth/authorize';

/** Stash the intended consent destination (path + query) before bouncing to login. */
export function setOAuthReturn(pathAndSearch: string): void {
  if (!pathAndSearch.startsWith(ALLOWED_PREFIX)) return;
  try {
    sessionStorage.setItem(KEY, pathAndSearch);
  } catch {
    // sessionStorage unavailable (private mode / disabled) — the return is best-effort; login still works.
  }
}

/** Read-and-clear the stashed destination. Returns a safe `/oauth/authorize…` path, or null. */
export function consumeOAuthReturn(): string | null {
  let value: string | null = null;
  try {
    value = sessionStorage.getItem(KEY);
    if (value !== null) sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  return value && value.startsWith(ALLOWED_PREFIX) ? value : null;
}
