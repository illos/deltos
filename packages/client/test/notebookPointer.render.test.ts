/**
 * IDB-backed notebook pointer tests (jsdom env — localStorage + fake-indexeddb available).
 *
 * Covered:
 *   NP-1  readCurrentNotebookId returns null when IDB is empty
 *   NP-2  writeCurrentNotebookId + readCurrentNotebookId round-trips correctly
 *   NP-3  loadCurrentNotebookId migrates from the legacy localStorage key (one-time)
 *   NP-4  localStorage key is removed after migration
 *   NP-5  loadCurrentNotebookId returns null when neither IDB nor localStorage has a value
 *   NP-6  a corrupt localStorage value (non-UUID) is ignored; returns null
 *
 * IDB write safety: plain Dexie put/get — no liveQuery active. Real timers used throughout.
 * See dexie-faketimers-deadlock memory.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { NotebookId } from '@deltos/shared';

const LEGACY_KEY = 'deltos.defaultNotebookId';
const VALID_ID = 'aabbccdd-1111-4111-8111-111111111111' as NotebookId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await db.deviceState.clear();
  localStorage.clear();
});

describe('NP-1 — readCurrentNotebookId returns null on empty IDB', () => {
  it('returns null when deviceState table has no current-notebook entry', async () => {
    const { readCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    const id = await readCurrentNotebookId();
    expect(id).toBeNull();
  });
});

describe('NP-2 — write + read round-trip', () => {
  it('reads back the exact ID that was written', async () => {
    const { readCurrentNotebookId, writeCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    await writeCurrentNotebookId(VALID_ID);
    const id = await readCurrentNotebookId();
    expect(id).toBe(VALID_ID);
  });
});

describe('NP-3 — loadCurrentNotebookId migrates from legacy localStorage key', () => {
  it('reads from localStorage when IDB is empty and returns the migrated ID', async () => {
    localStorage.setItem(LEGACY_KEY, VALID_ID);
    const { loadCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    const id = await loadCurrentNotebookId();
    expect(id).toBe(VALID_ID);
  });
});

describe('NP-4 — legacy localStorage key is removed after migration', () => {
  it('clears the old localStorage key once it has been saved to IDB', async () => {
    localStorage.setItem(LEGACY_KEY, VALID_ID);
    const { loadCurrentNotebookId, readCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    await loadCurrentNotebookId();
    // localStorage key removed
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    // IDB now has the value (subsequent loads come from IDB, not localStorage)
    expect(await readCurrentNotebookId()).toBe(VALID_ID);
  });
});

describe('NP-5 — loadCurrentNotebookId returns null when both sources are empty', () => {
  it('returns null when IDB and localStorage both have no notebook ID', async () => {
    const { loadCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    const id = await loadCurrentNotebookId();
    expect(id).toBeNull();
  });
});

describe('NP-6 — corrupt localStorage value is ignored', () => {
  it('returns null when localStorage has a non-UUID value', async () => {
    localStorage.setItem(LEGACY_KEY, 'not-a-uuid');
    const { loadCurrentNotebookId } = await import('../src/db/notebookPointer.js');
    const id = await loadCurrentNotebookId();
    expect(id).toBeNull();
  });
});
