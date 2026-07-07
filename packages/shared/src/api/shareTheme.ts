import { z } from 'zod';

/**
 * Share-surface theme substrate (ROAD-0011 P2) — the palette/voice IDENTITY enums + the compact color-token
 * subset the PUBLIC `/s/<token>` render inlines, plus the same-origin font faces per voice.
 *
 * VISUAL SOURCE OF TRUTH = the client's `packages/client/src/theme/tokens.css` (hand-authored hex per
 * palette×mode). This module EXTRACTS only the tokens the server-rendered share page needs so the worker
 * never imports client CSS (CONV-0004 — zero app bundle) AND the hex can't silently drift across a copy. When
 * a palette's hex changes in tokens.css, update the matching entry here.
 *
 * The enums are STRICT (`z.enum`) and mirror the client's `PALETTES` / `VOICES` (db/themePointer.ts) exactly,
 * so a mint request can only ever carry a KNOWN palette/voice — no arbitrary string reaches the inlined CSS
 * (prevents CSS injection at the render).
 */

/** Palette axis — MUST match the client PALETTES (bone | graphite | manila | ember). */
export const PaletteSchema = z.enum(['bone', 'graphite', 'manila', 'ember']);
export type Palette = z.infer<typeof PaletteSchema>;

/** Voice (font) axis — MUST match the client VOICES (sans | mono | serif | grotesk). */
export const VoiceSchema = z.enum(['sans', 'mono', 'serif', 'grotesk']);
export type Voice = z.infer<typeof VoiceSchema>;

/** The theme stamped onto a share at mint (the owner's palette+voice, frozen at link creation). */
export interface ShareTheme {
  palette: Palette;
  voice: Voice;
}

/**
 * Fallback for shares with NO stamp — older shares minted before this change (their `shareTheme` is NULL).
 * Matches the client DEFAULT_THEME axes (graphite × sans).
 */
export const SHARE_THEME_FALLBACK: ShareTheme = { palette: 'graphite', voice: 'sans' };

/**
 * Parse the stored `shareTheme` JSON to a validated {@link ShareTheme}, or null. Fail-closed: a NULL/absent
 * column, malformed JSON, or an out-of-enum value all degrade to null (→ the caller applies the fallback), so
 * only a KNOWN palette/voice can ever reach the render.
 */
export function parseShareTheme(raw: string | null | undefined): ShareTheme | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { palette?: unknown; voice?: unknown };
    const palette = PaletteSchema.safeParse(v.palette);
    const voice = VoiceSchema.safeParse(v.voice);
    if (!palette.success || !voice.success) return null;
    return { palette: palette.data, voice: voice.data };
  } catch {
    return null;
  }
}

/**
 * The color-token subset the share render uses, per mode. Keys mirror tokens.css var names (`--paper` …), so
 * the inlined CSS declares `--paper: <paper>; --ink: <ink>; …` directly. All are USED by the share page CSS.
 */
export interface ShareColorTokens {
  paper: string; // --paper : page background
  ink: string; // --ink : primary text / headings
  body: string; // --body : body copy
  secondary: string; // --secondary : meta / secondary text
  faint: string; // --faint : faint (offline dot)
  border: string; // --border : rules / borders
  accent: string; // --accent : links / accent
  sync: string; // --sync : the live dot (always-green family, per palette)
}

/**
 * Per-palette LIGHT + DARK token values, extracted VERBATIM from tokens.css (the visual source of truth).
 * Keep in sync when a palette's hex changes there.
 */
export const SHARE_PALETTE_TOKENS: Record<Palette, { light: ShareColorTokens; dark: ShareColorTokens }> = {
  bone: {
    light: { paper: '#FAF7F0', ink: '#25201A', body: '#3A332A', secondary: '#8A8170', faint: '#A0967F', border: '#E0D8C8', accent: '#A8662F', sync: '#7FA86B' },
    dark: { paper: '#26211A', ink: '#EDE6D8', body: '#D8D0C0', secondary: '#9C9484', faint: '#857C6A', border: '#332E25', accent: '#C98A4A', sync: '#8FBE78' },
  },
  graphite: {
    light: { paper: '#FFFFFF', ink: '#1A1C1F', body: '#33373D', secondary: '#6B7177', faint: '#8A9099', border: '#E5E7EB', accent: '#3B5BDB', sync: '#3BA776' },
    dark: { paper: '#202225', ink: '#E6E8EB', body: '#C4C8CD', secondary: '#8B9197', faint: '#777E85', border: '#2C2F33', accent: '#5B7BFF', sync: '#42C28C' },
  },
  manila: {
    light: { paper: '#F8F7F0', ink: '#2B2722', body: '#423C33', secondary: '#877F70', faint: '#A89F8C', border: '#DFDACE', accent: '#9E3B2E', sync: '#7B9A66' },
    dark: { paper: '#25221B', ink: '#E8E2D4', body: '#CBC3B3', secondary: '#968D7C', faint: '#857C6A', border: '#322D24', accent: '#C75A48', sync: '#8FAE74' },
  },
  ember: {
    light: { paper: '#FFFFFF', ink: '#17171A', body: '#36363B', secondary: '#6E6E76', faint: '#A0A0A8', border: '#E7E7EB', accent: '#EE431C', sync: '#1FA971' },
    dark: { paper: '#1A1A1D', ink: '#F0F0F2', body: '#C8C8CE', secondary: '#9A9AA3', faint: '#6E6E77', border: '#2A2A2E', accent: '#FF6242', sync: '#34C98A' },
  },
};

/** A voice's font-family stack + the same-origin woff2 faces to `@font-face` on the share page. */
export interface ShareVoiceFont {
  /** The primary `@font-face` family name (matches tokens.css). */
  family: string;
  /** The CSS `font-family` stack applied to `body`. */
  stack: string;
  /** `@font-face` descriptors: weight → same-origin `/fonts/*.woff2` (served by the worker's asset origin). */
  faces: Array<{ weight: number; src: string }>;
}

/**
 * Per-voice font faces, pointing at the SAME-ORIGIN woff2 in `packages/client/public/fonts/`. Only the two
 * weights the read-only render needs (body 400 + heading 600) — the app's fuller weight sets are not needed
 * for a static document. Font names/stacks mirror tokens.css.
 */
export const SHARE_VOICE_FONTS: Record<Voice, ShareVoiceFont> = {
  sans: {
    family: 'IBM Plex Sans',
    stack: `'IBM Plex Sans', system-ui, sans-serif`,
    faces: [
      { weight: 400, src: '/fonts/ibm-plex-sans-400.woff2' },
      { weight: 600, src: '/fonts/ibm-plex-sans-600.woff2' },
    ],
  },
  mono: {
    family: 'IBM Plex Mono',
    stack: `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
    faces: [
      { weight: 400, src: '/fonts/ibm-plex-mono-400.woff2' },
      { weight: 600, src: '/fonts/ibm-plex-mono-600.woff2' },
    ],
  },
  serif: {
    family: 'Newsreader',
    stack: `'Newsreader', Georgia, serif`,
    faces: [
      { weight: 400, src: '/fonts/newsreader-400.woff2' },
      { weight: 600, src: '/fonts/newsreader-600.woff2' },
    ],
  },
  grotesk: {
    family: 'Space Grotesk',
    stack: `'Space Grotesk', system-ui, sans-serif`,
    faces: [
      { weight: 400, src: '/fonts/space-grotesk-400.woff2' },
      { weight: 600, src: '/fonts/space-grotesk-600.woff2' },
    ],
  },
};
