/**
 * Lightweight publish/subscribe for in-app toast notifications.
 *
 * The sync engine (devSys2) calls showConflictToast() when a conflict is stored.
 * ToastHost subscribes and renders. No React dependency here — plain module-level state.
 *
 * Auto-dismiss: toasts remove themselves after TOAST_TTL_MS. Listeners are notified
 * on both add and remove so ToastHost can run enter/exit animations.
 */

const TOAST_TTL_MS = 4500;

export interface ToastMessage {
  id: string;
  message: string;
  /** Optional note ID — ToastHost uses it to make the toast tappable (navigate to note). */
  noteId?: string;
}

type ToastListener = (toasts: readonly ToastMessage[]) => void;

const _listeners = new Set<ToastListener>();
let _toasts: ToastMessage[] = [];

function _notify(): void {
  const snapshot = _toasts as readonly ToastMessage[];
  _listeners.forEach((fn) => fn(snapshot));
}

/** Show a generic toast. Returns the generated id (for testing / manual dismiss). */
export function showToast(message: string, noteId?: string): string {
  const id = crypto.randomUUID();
  _toasts = [..._toasts, { id, message, ...(noteId !== undefined ? { noteId } : {}) }];
  _notify();
  setTimeout(() => dismissToast(id), TOAST_TTL_MS);
  return id;
}

/** Dismiss a toast by ID (called by the timer or by a user close tap). */
export function dismissToast(id: string): void {
  _toasts = _toasts.filter((t) => t.id !== id);
  _notify();
}

/**
 * Called by the sync engine when a conflict is handled.
 * devSys2: call this from handleConflict() after applyConflict() succeeds.
 */
export function showConflictToast(noteId: string, title: string): void {
  // Belt: skip if a live toast for this note already exists (dedup at the toast layer).
  if (_toasts.some((t) => t.noteId === noteId)) return;
  showToast(`Sync conflict on "${title}" — your version was kept.`, noteId);
}

/** Subscribe to toast state. Fires immediately with the current list. Returns unsubscribe fn. */
export function subscribeToasts(fn: ToastListener): () => void {
  _listeners.add(fn);
  fn(_toasts);
  return () => _listeners.delete(fn);
}

/** Sync snapshot for initial state in useState(getToasts). */
export function getToasts(): readonly ToastMessage[] {
  return _toasts;
}
