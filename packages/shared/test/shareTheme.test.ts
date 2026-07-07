import { describe, it, expect } from 'vitest';
import {
  ShareMintRequestSchema,
  PaletteSchema,
  VoiceSchema,
  parseShareTheme,
  SHARE_THEME_FALLBACK,
  SHARE_PALETTE_TOKENS,
  SHARE_VOICE_FONTS,
} from '../src/api/index.js';

/**
 * ROAD-0011 P2 share THEME stamping. The palette/voice on a mint request are STRICT enums so no arbitrary
 * string can ever reach the inlined render CSS (no injection). These pin: the mint schema accepts a valid
 * stamp, stays optional, and rejects anything off-enum; the stored-theme parser fail-closes; and the shared
 * token/font maps cover all axes (the render's source-of-truth mirror of tokens.css).
 */

describe('ShareMintRequestSchema — theme stamp', () => {
  it('accepts a valid palette + voice', () => {
    const parsed = ShareMintRequestSchema.parse({
      resourceType: 'note',
      resourceId: 'n1',
      palette: 'ember',
      voice: 'mono',
    });
    expect(parsed.palette).toBe('ember');
    expect(parsed.voice).toBe('mono');
  });

  it('leaves palette/voice OPTIONAL (older clients omit them)', () => {
    const parsed = ShareMintRequestSchema.parse({ resourceType: 'note', resourceId: 'n1' });
    expect(parsed.palette).toBeUndefined();
    expect(parsed.voice).toBeUndefined();
  });

  it('REJECTS an arbitrary palette (would be a CSS-injection vector)', () => {
    expect(
      ShareMintRequestSchema.safeParse({
        resourceType: 'note',
        resourceId: 'n1',
        palette: 'red;}body{background:url(evil)',
        voice: 'sans',
      }).success,
    ).toBe(false);
  });

  it('REJECTS an arbitrary voice', () => {
    expect(
      ShareMintRequestSchema.safeParse({ resourceType: 'note', resourceId: 'n1', palette: 'ember', voice: 'comic' })
        .success,
    ).toBe(false);
  });

  it('the enums mirror the client PALETTES/VOICES exactly', () => {
    expect(PaletteSchema.options).toEqual(['bone', 'graphite', 'manila', 'ember']);
    expect(VoiceSchema.options).toEqual(['sans', 'mono', 'serif', 'grotesk']);
  });
});

describe('parseShareTheme — stored value → validated theme (fail-closed)', () => {
  it('parses a valid stamp', () => {
    expect(parseShareTheme(JSON.stringify({ palette: 'bone', voice: 'serif' }))).toEqual({
      palette: 'bone',
      voice: 'serif',
    });
  });

  it('returns null for null / empty / malformed / off-enum', () => {
    expect(parseShareTheme(null)).toBeNull();
    expect(parseShareTheme('')).toBeNull();
    expect(parseShareTheme('{not json')).toBeNull();
    expect(parseShareTheme(JSON.stringify({ palette: 'nope', voice: 'sans' }))).toBeNull();
    expect(parseShareTheme(JSON.stringify({ palette: 'ember' }))).toBeNull();
  });

  it('the fallback is graphite × sans (matches the client default axes)', () => {
    expect(SHARE_THEME_FALLBACK).toEqual({ palette: 'graphite', voice: 'sans' });
  });
});

describe('shared render token/font maps', () => {
  it('covers every palette light+dark with the needed tokens', () => {
    for (const p of PaletteSchema.options) {
      for (const mode of ['light', 'dark'] as const) {
        const t = SHARE_PALETTE_TOKENS[p][mode];
        for (const key of ['paper', 'ink', 'body', 'secondary', 'faint', 'border', 'accent', 'sync'] as const) {
          expect(t[key]).toMatch(/^#[0-9A-Fa-f]{3,8}$/);
        }
      }
    }
  });

  it('covers every voice with a same-origin /fonts woff2 face set', () => {
    for (const v of VoiceSchema.options) {
      const f = SHARE_VOICE_FONTS[v];
      expect(f.faces.length).toBeGreaterThan(0);
      for (const face of f.faces) expect(face.src).toMatch(/^\/fonts\/.+\.woff2$/);
    }
  });
});
