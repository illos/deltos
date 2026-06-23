import { getStore } from '../db/store.js';
import { notifyQueueWrite } from './syncEngine.js';
import type { DictionaryWordRow, DictionaryQueueEntry } from '../db/schema.js';
import type { Unsubscribe } from '../db/localStore.js';

/**
 * Custom-dictionary client store (custom-keyboard spec §5.2) — the clean consumer API over the
 * account-synced dictionary entity. The §5.1 suggestion bar's `[+ Add to dictionary]` action calls
 * {@link addWord}; the spellcheck engine consumes {@link listWords}/{@link observeWords} as its custom
 * allow-list; the Settings manage-UI uses all of list/observe/add/remove. (All consumers = devSys-2.)
 *
 * SET SEMANTICS, conflict-free: add = upsert a live row, remove = tombstone — both optimistic-local +
 * enqueued for the existing account-scoped sync engine to push (and the server upserts idempotently).
 * Every word is normalized (trim + lowercase) so "Deltos", "deltos ", "DELTOS" are one set element.
 *
 * ACCOUNT ISOLATION: the underlying Dexie tables are cleared on every account switch (db/accountScope.ts
 * wipeLocalState), so this store only ever exposes the resident account's words — same guarantee as notes
 * and notebooks. There is no cross-account read path.
 */

/** Normalize a word to its canonical set-element form (the identity used everywhere). */
export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

/** All live custom words for the current account (one-shot, sorted). */
export function listWords(): Promise<string[]> {
  return getStore().listDictionaryWords();
}

/** Reactive subscription to the live custom-word set (for the engine allow-list + manage-UI). */
export function observeWords(cb: (words: string[]) => void): Unsubscribe {
  return getStore().observeDictionaryWords(cb);
}

/**
 * Add a word to the custom dictionary (optimistic-local + queued for sync). No-op on a blank word.
 * Idempotent: re-adding an existing word just re-confirms it (and un-tombstones a removed one).
 */
export async function addWord(word: string): Promise<void> {
  const w = normalizeWord(word);
  if (w.length === 0) return;
  const now = new Date().toISOString();
  const row: DictionaryWordRow = { word: w, createdAt: now, updatedAt: now, deletedAt: null, syncSeq: 0 };
  const entry: DictionaryQueueEntry = { id: crypto.randomUUID(), recordId: w, payload: { word: w }, createdAt: now };
  await getStore().putDictionaryWordAndEnqueue(row, entry);
  notifyQueueWrite(null); // arm the debounced push (dictionary rides the same sync cycle)
}

/**
 * Remove a word from the custom dictionary (optimistic-local tombstone + queued for sync). No-op on a
 * blank word. The tombstone streams to other devices so the removal converges everywhere.
 */
export async function removeWord(word: string): Promise<void> {
  const w = normalizeWord(word);
  if (w.length === 0) return;
  const now = new Date().toISOString();
  const row: DictionaryWordRow = { word: w, createdAt: now, updatedAt: now, deletedAt: now, syncSeq: 0 };
  const entry: DictionaryQueueEntry = { id: crypto.randomUUID(), recordId: w, payload: { word: w, delete: true }, createdAt: now };
  await getStore().putDictionaryWordAndEnqueue(row, entry);
  notifyQueueWrite(null);
}
