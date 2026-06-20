import { db } from './schema.js';

/**
 * Desktop list-pane width — device-local persistence (UI refresh, Lane 2 Pass B). Mirrors
 * {@link notebookPointer} / {@link themePointer}: a single key→value row in the `deviceState` Dexie
 * table. DEVICE-global (a per-device layout preference, like the theme), NOT account data and NOT
 * synced — so it must SURVIVE an account-change/logout wipe.
 *
 * INTEGRATION NOTE: when ui-refresh merges to mainline (which carries #57's deny-by-default
 * deviceState wipe), add LIST_PANE_WIDTH_KEY to accountScope's DEVICE_GLOBAL_DEVICE_KEYS allowlist
 * so it isn't wiped on account change. (On ui-refresh today the wipe still clears only the notebook
 * pointer, so this key already survives.)
 */

const LIST_PANE_WIDTH_KEY = 'list-pane-width';

export const DEFAULT_LIST_PANE_WIDTH = 300;
export const MIN_LIST_PANE_WIDTH = 220;
export const MAX_LIST_PANE_WIDTH = 520;

/** Clamp to the allowed pane range (keeps the note region usable; guards a corrupt stored value). */
export function clampListPaneWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_LIST_PANE_WIDTH;
  return Math.min(MAX_LIST_PANE_WIDTH, Math.max(MIN_LIST_PANE_WIDTH, Math.round(px)));
}

export async function readListPaneWidth(): Promise<number> {
  const row = await db.deviceState.get(LIST_PANE_WIDTH_KEY);
  return clampListPaneWidth(row ? Number(row.value) : NaN);
}

export async function writeListPaneWidth(px: number): Promise<void> {
  await db.deviceState.put({ key: LIST_PANE_WIDTH_KEY, value: String(clampListPaneWidth(px)) });
}
