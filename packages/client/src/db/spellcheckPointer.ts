import { db } from './schema.js';

/**
 * Spellcheck opt-out — device-local persistence (#69 §5). Mirrors {@link readCustomKeyboard}: a single
 * key→value row in the `deviceState` Dexie table. DEVICE-global (a per-device preference, not account
 * data, not synced) so it survives an account-change/logout wipe — registered in accountScope's
 * DEVICE_GLOBAL_DEVICE_KEYS.
 *
 * DEFAULT ON (Jim): local spellcheck ships enabled; only an explicit disable turns it off. So an unset
 * row reads as ON — only the literal 'false' disables.
 */

export const SPELLCHECK_KEY = 'spellcheck';

export async function readSpellcheck(): Promise<boolean> {
  const row = await db.deviceState.get(SPELLCHECK_KEY);
  return row?.value !== 'false'; // default ON: unset / 'true' → on; only 'false' → off
}

export async function writeSpellcheck(enabled: boolean): Promise<void> {
  await db.deviceState.put({ key: SPELLCHECK_KEY, value: enabled ? 'true' : 'false' });
}
