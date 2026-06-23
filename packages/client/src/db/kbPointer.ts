import { db } from './schema.js';

/**
 * Custom-keyboard opt-in — device-local persistence (#69 Phase 1). Mirrors {@link panePointer} /
 * {@link themePointer}: a single key→value row in the `deviceState` Dexie table. DEVICE-global (a
 * per-device preference, not account data, not synced) so it survives an account-change/logout wipe —
 * registered in accountScope's DEVICE_GLOBAL_DEVICE_KEYS.
 *
 * DEFAULT OFF (Jim, via navSys): until flipped, the real editor behaves exactly as today (native
 * keyboard, no inputmode=none). Phase 1 has no number/symbol layer, so default-on would brick real
 * note typing — it's strictly opt-in until Phase 2 lands 123/#+= and it's proven on-device.
 */

export const CUSTOM_KEYBOARD_KEY = 'custom-keyboard';

export async function readCustomKeyboard(): Promise<boolean> {
  const row = await db.deviceState.get(CUSTOM_KEYBOARD_KEY);
  return row?.value === 'true';
}

export async function writeCustomKeyboard(enabled: boolean): Promise<void> {
  await db.deviceState.put({ key: CUSTOM_KEYBOARD_KEY, value: enabled ? 'true' : 'false' });
}
