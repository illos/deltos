import type { LocalStore } from './localStore.js';
import { dexieLocalStore } from './dexieLocalStore.js';

/**
 * The active {@link LocalStore}. Defaults to the Dexie adapter; {@link configureStore} swaps it (for
 * tests, or a native-SQLite adapter later). Surfaces, hooks, mutate, and the sync engine all resolve
 * the store through {@link getStore} — none import a concrete adapter — so swapping persistence is a
 * one-line change here, with zero consumer edits.
 */
let _store: LocalStore = dexieLocalStore;

export function getStore(): LocalStore {
  return _store;
}

/** Swap the active store (tests / a future native adapter). */
export function configureStore(store: LocalStore): void {
  _store = store;
}
