/**
 * iOS-safe body scroll lock.
 *
 * Plain `overflow:hidden` on the body does NOT prevent scroll in mobile Safari —
 * the only reliable approach is temporarily making the body `position:fixed` while
 * preserving and restoring the scroll position on unlock.
 *
 * Reference-counted so multiple callers can lock/unlock independently; the body
 * is only restored once all callers have unlocked.
 */

let savedScrollY = 0;
let lockCount = 0;

export function lockBodyScroll(): void {
  if (lockCount++ > 0) return; // already locked
  savedScrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${savedScrollY}px`;
  document.body.style.width = '100%';
}

export function unlockBodyScroll(): void {
  if (lockCount <= 0) return; // already unlocked — no-op (safe to call idempotently)
  if (--lockCount > 0) return; // other callers still hold the lock
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, savedScrollY);
}

/** Reset module state between tests. Not for production use. */
export function _resetBodyScrollLockForTest(): void {
  lockCount = 0;
  savedScrollY = 0;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
}
