/**
 * #101 — a tiny registry so a hard reload (the SyncIndicator tap-to-reload) can COMMIT any in-memory
 * debounced editor edit to Dexie BEFORE the page unloads. IndexedDB transactions abort on unload, so the
 * commit must be AWAITED, not fire-and-forget. The open editor registers a flush; the reload handler awaits
 * flushPendingEdits() first → nothing sitting in the save-debounce window is lost.
 *
 * Decoupled by design: the editor is the only registrant today, but the registry has no editor dependency,
 * so any other in-memory buffer that must reach Dexie before a reload can opt in the same way.
 */
type FlushFn = () => Promise<void>;

const flushers = new Set<FlushFn>();

/** Register a flush (the editor's pending-save commit). Returns an unregister fn for effect cleanup. */
export function registerPendingEditFlush(fn: FlushFn): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/**
 * Await every registered flush. Best-effort per flush — a thrown/rejected flush is swallowed so one bad
 * registrant can't block the others (or the reload). Resolves immediately when nothing is registered.
 */
export async function flushPendingEdits(): Promise<void> {
  await Promise.all([...flushers].map((fn) => fn().catch(() => {})));
}
