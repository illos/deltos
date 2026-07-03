import { db } from './schema.js';

/**
 * Appearance theme — device-local persistence boundary. Mirrors {@link notebookPointer}: a single
 * key→value row in the `deviceState` Dexie table (device-local IndexedDB, NEVER synced, NEVER
 * localStorage — iOS evicts localStorage under pressure, see e4-cold-reload-fix). One JSON row.
 *
 * This module is the schema owner for the theme axes (the persisted shape) + their validation, so
 * the union types live here and themeStore re-exports them for UI consumers.
 */

export type Palette = 'bone' | 'graphite' | 'manila' | 'ember';
export type Voice = 'serif' | 'sans' | 'mono' | 'grotesk';
export type Mode = 'light' | 'dark' | 'system';

export interface ThemeState {
  palette: Palette;
  voice: Voice;
  mode: Mode;
}

export const PALETTES: readonly Palette[] = ['bone', 'graphite', 'manila', 'ember'];
export const VOICES: readonly Voice[] = ['serif', 'sans', 'mono', 'grotesk'];
export const MODES: readonly Mode[] = ['light', 'dark', 'system'];

/** Settings-revamp handoff default = Graphite × Sans × light. Fresh devices only (a stored theme row
 *  overrides this on init); flipping it never migrates an existing device's saved preference. */
export const DEFAULT_THEME: ThemeState = { palette: 'graphite', voice: 'sans', mode: 'light' };

const THEME_KEY = 'appearance-theme'; // single deviceState row, JSON-encoded ThemeState

/**
 * Read the persisted theme, validating each axis against its union independently so a
 * forward-incompatible or corrupt row degrades per-field to the default rather than throwing.
 */
export async function readTheme(): Promise<ThemeState> {
  const row = await db.deviceState.get(THEME_KEY);
  if (!row) return { ...DEFAULT_THEME };
  try {
    const v = JSON.parse(row.value) as Partial<ThemeState>;
    return {
      palette: PALETTES.includes(v.palette as Palette) ? (v.palette as Palette) : DEFAULT_THEME.palette,
      voice: VOICES.includes(v.voice as Voice) ? (v.voice as Voice) : DEFAULT_THEME.voice,
      mode: MODES.includes(v.mode as Mode) ? (v.mode as Mode) : DEFAULT_THEME.mode,
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export async function writeTheme(t: ThemeState): Promise<void> {
  await db.deviceState.put({ key: THEME_KEY, value: JSON.stringify(t) });
}
