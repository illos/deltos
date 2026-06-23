/**
 * #69 §5 spellcheck — the device-local toggle (mirrors the custom-keyboard toggle, but DEFAULT ON).
 * Pointer persistence + the shared Zustand store hydration.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/schema.js';
import { readSpellcheck, writeSpellcheck, SPELLCHECK_KEY } from '../src/db/spellcheckPointer.js';
import { useSpellcheckStore } from '../src/lib/useSpellcheck.js';

beforeEach(async () => {
  await db.deviceState.clear();
  useSpellcheckStore.setState({ enabled: true, _loaded: false });
});

describe('spellcheckPointer — device-local, DEFAULT ON', () => {
  it('reads ON when unset (default), persists a disable, re-enables', async () => {
    expect(await readSpellcheck()).toBe(true);   // unset → on
    await writeSpellcheck(false);
    expect(await readSpellcheck()).toBe(false);   // explicit off
    await writeSpellcheck(true);
    expect(await readSpellcheck()).toBe(true);
  });

  it('stores under the device-global key (survives logout wipe via accountScope allowlist)', async () => {
    await writeSpellcheck(false);
    expect((await db.deviceState.get(SPELLCHECK_KEY))?.value).toBe('false');
  });
});

describe('useSpellcheckStore — shared reactive state', () => {
  it('init() hydrates the persisted value; set() flips + persists', async () => {
    await writeSpellcheck(false);
    await useSpellcheckStore.getState().init();
    expect(useSpellcheckStore.getState().enabled).toBe(false);
    expect(useSpellcheckStore.getState()._loaded).toBe(true);

    useSpellcheckStore.getState().set(true);
    expect(useSpellcheckStore.getState().enabled).toBe(true);
    expect(await readSpellcheck()).toBe(true); // persisted
  });
});
