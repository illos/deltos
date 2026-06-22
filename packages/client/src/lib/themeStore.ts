import { create } from 'zustand';
import {
  readTheme,
  writeTheme,
  DEFAULT_THEME,
  type Palette,
  type Voice,
  type Mode,
  type ThemeState,
} from '../db/themePointer.js';

// Re-export the axis types from the store so UI consumers import them from one place.
export type { Palette, Voice, Mode, ThemeState } from '../db/themePointer.js';
export { DEFAULT_THEME } from '../db/themePointer.js';

/**
 * Appearance theme store — a tiny Zustand store over the device-local `deviceState` IDB row
 * (see {@link themePointer}). Applies the three axes as `data-palette` / `data-voice` / `data-mode`
 * on the theme root (<html>); CSS in `theme/tokens.css` reads them. NOT synced, NOT account-scoped —
 * appearance is a per-device preference.
 *
 * palette/voice boot to the placeholder default (Ember × Sans); a future onboarding/Appearance flow
 * (Lane 5) sets them for real, so setPalette/setVoice are fully wired — nothing is hardcoded.
 */

/** The theme root element. Indirected so tests can run without a real document at import time. */
function root(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}

/** Write the three axes onto <html>. index.html ships the default attrs statically (no-flash boot). */
export function applyToRoot(t: ThemeState): void {
  const el = root();
  if (!el) return;
  el.dataset.palette = t.palette;
  el.dataset.voice = t.voice;
  el.dataset.mode = t.mode;
}

/**
 * Resolve `mode` to the concrete `light`/`dark` actually in effect. `system` consults the OS
 * preference. Tokens.css handles `system` natively in CSS; this is for JS that needs the concrete
 * value (e.g. a future mode-aware `<meta name="theme-color">`).
 */
export function resolvedMode(mode: Mode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  return mql?.matches ? 'dark' : 'light';
}

/**
 * Lazy-voice font loader SEAM. Sans is precached (default); Mono is precached for metadata so the
 * Mono voice reuses it — both `null`. Serif (Newsreader) + Grotesk woff2 + their CSS chunks are
 * deferred to Lane 5 (Appearance picker), so they are `null` here too; the seam is live (setVoice
 * always calls it) and Lane 5 only has to drop in the dynamic `import()` + the woff2 files:
 *
 *   serif:   () => import('../styles/fonts/newsreader.css'),
 *   grotesk: () => import('../styles/fonts/space-grotesk.css'),
 *
 * The SW caches /fonts/* cache-first with no expiry, so a lazy voice is a one-time fetch then forever.
 */
const FONT_CHUNK: Record<Voice, (() => Promise<unknown>) | null> = {
  sans: null, // precached
  mono: null, // reuses the precached Plex Mono metadata faces
  serif:   () => import('../styles/fonts/newsreader.css'),   // Lane 5: full Newsreader faces, lazy
  grotesk: () => import('../styles/fonts/space-grotesk.css'), // Lane 5: full Space Grotesk faces, lazy
};

/** Fetch the voice's font chunk on first selection (idempotent — the bundler caches the module). */
export async function loadVoiceFont(voice: Voice): Promise<void> {
  await FONT_CHUNK[voice]?.();
}

interface ThemeStore extends ThemeState {
  /** False until init() has resolved the persisted theme from IDB. */
  _ready: boolean;
  /** Read IDB + apply to the root. Call once on app mount. */
  init(): Promise<void>;
  setPalette(p: Palette): Promise<void>;
  setVoice(v: Voice): Promise<void>;
  setMode(m: Mode): Promise<void>;
}

const pick = (s: ThemeState): ThemeState => ({ palette: s.palette, voice: s.voice, mode: s.mode });

export const useThemeStore = create<ThemeStore>((set, get) => ({
  ...DEFAULT_THEME, // sensible default BEFORE IDB resolves → no flash
  _ready: false,

  async init() {
    const t = await readTheme();
    applyToRoot(t);
    set({ ...t, _ready: true });
  },

  async setPalette(palette) {
    const t = { ...pick(get()), palette };
    await writeTheme(t);
    applyToRoot(t);
    set(t);
  },

  async setVoice(voice) {
    const t = { ...pick(get()), voice };
    await loadVoiceFont(voice); // lazy font chunk (inert for precached voices)
    await writeTheme(t);
    applyToRoot(t);
    set(t);
  },

  async setMode(mode) {
    const t = { ...pick(get()), mode };
    await writeTheme(t);
    applyToRoot(t);
    set(t);
  },
}));
