import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db/schema.js';
import { readTheme, writeTheme, DEFAULT_THEME } from '../src/db/themePointer.js';
import { useThemeStore, applyToRoot, resolvedMode } from '../src/lib/themeStore.js';

/**
 * Lane-0 acceptance gate (UI visual refresh). Proves the theme foundation:
 *   - default applies (no IDB row → Graphite × Sans × light on <html>)
 *   - a swap flips the root axes AND persists to device-local IDB
 *   - corrupt/forward-incompatible rows degrade per-field to the default
 *   - mode=system resolves the OS preference (prefers-color-scheme)
 *   - tokens.css defines all 12 color tokens for every palette × {light,dark} + the 12 type-scale
 *     vars per voice + the cross-theme invariants (the values the CSS swap actually flips).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = () => document.documentElement;

beforeEach(async () => {
  await db.deviceState.clear();
  useThemeStore.setState({ ...DEFAULT_THEME, _ready: false });
  delete html().dataset.palette;
  delete html().dataset.voice;
  delete html().dataset.mode;
});
afterEach(() => vi.unstubAllGlobals());

describe('themeStore — default + persistence', () => {
  it('default applies: no IDB row boots Graphite × Sans × light on <html>', async () => {
    await useThemeStore.getState().init();
    expect(html().dataset.palette).toBe('graphite');
    expect(html().dataset.voice).toBe('sans');
    expect(html().dataset.mode).toBe('light');
    expect(useThemeStore.getState()._ready).toBe(true);
  });

  it('setPalette/setVoice/setMode flip the root axes AND persist to IDB', async () => {
    await useThemeStore.getState().init();
    await useThemeStore.getState().setPalette('graphite');
    await useThemeStore.getState().setVoice('mono');
    await useThemeStore.getState().setMode('dark');

    expect(html().dataset.palette).toBe('graphite');
    expect(html().dataset.voice).toBe('mono');
    expect(html().dataset.mode).toBe('dark');

    // Persisted: a fresh read returns the swapped theme (survives reload).
    expect(await readTheme()).toEqual({ palette: 'graphite', voice: 'mono', mode: 'dark' });
  });

  it('a persisted theme is re-applied on init (overwrites the static default)', async () => {
    await writeTheme({ palette: 'manila', voice: 'grotesk', mode: 'light' });
    await useThemeStore.getState().init();
    expect(html().dataset.palette).toBe('manila');
    expect(html().dataset.voice).toBe('grotesk');
    expect(html().dataset.mode).toBe('light');
  });

  it('a corrupt / forward-incompatible row degrades per-field to the default', async () => {
    await db.deviceState.put({ key: 'appearance-theme', value: JSON.stringify({ palette: 'neon', voice: 'sans', mode: 'dark' }) });
    expect(await readTheme()).toEqual({ palette: 'graphite', voice: 'sans', mode: 'dark' });

    await db.deviceState.put({ key: 'appearance-theme', value: 'not json{' });
    expect(await readTheme()).toEqual(DEFAULT_THEME);
  });

  it('applyToRoot is a no-op-safe writer of the three axes', () => {
    applyToRoot({ palette: 'bone', voice: 'serif', mode: 'light' });
    expect(html().dataset).toMatchObject({ palette: 'bone', voice: 'serif', mode: 'light' });
  });
});

describe('resolvedMode — mode=system honors prefers-color-scheme', () => {
  const stubMatchMedia = (matches: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {} }));

  it('system → dark when the OS prefers dark', () => {
    stubMatchMedia(true);
    expect(resolvedMode('system')).toBe('dark');
  });
  it('system → light when the OS prefers light', () => {
    stubMatchMedia(false);
    expect(resolvedMode('system')).toBe('light');
  });
  it('an explicit mode is returned as-is regardless of the OS preference', () => {
    stubMatchMedia(true);
    expect(resolvedMode('light')).toBe('light');
    expect(resolvedMode('dark')).toBe('dark');
  });
});

describe('tokens.css — completeness + invariants', () => {
  const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8');
  const COLOR_TOKENS = [
    '--paper', '--list', '--nav', '--border', '--ink', '--body',
    '--secondary', '--faint', '--sel', '--accent', '--handle', '--sync',
  ];
  const PALETTES = ['bone', 'graphite', 'manila', 'ember'] as const;
  const VOICES = ['serif', 'sans', 'mono', 'grotesk'] as const;
  const SCALE_VARS = ['--ff', '--h1', '--h2', '--note', '--line', '--lt', '--nav-item', '--quote', '--list-note'];

  /** The selector block body for a `[data-palette=X][data-mode=Y]` rule (first match). */
  function paletteBlock(palette: string, mode: 'light' | 'dark'): string {
    const re = new RegExp(`\\[data-palette="${palette}"\\]\\[data-mode="${mode}"\\][^{]*\\{([^}]*)\\}`);
    const m = css.match(re);
    return m ? m[1] : '';
  }
  function voiceBlock(voice: string): string {
    const re = new RegExp(`\\[data-voice="${voice}"\\]\\s*\\{([^}]*)\\}`);
    const m = css.match(re);
    return m ? m[1] : '';
  }

  it('every palette × {light, dark} defines all 12 color tokens', () => {
    for (const p of PALETTES) {
      for (const mode of ['light', 'dark'] as const) {
        const block = paletteBlock(p, mode);
        expect(block.length, `${p}/${mode} block`).toBeGreaterThan(0);
        for (const tok of COLOR_TOKENS) {
          expect(block, `${p}/${mode} missing ${tok}`).toContain(`${tok}:`);
        }
      }
    }
  });

  it('system mode re-points to each palette dark hex under prefers-color-scheme: dark', () => {
    const m = css.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*)\}\s*\}/);
    expect(m, 'system-dark @media block').not.toBeNull();
    for (const p of PALETTES) {
      expect(m![1]).toContain(`[data-palette="${p}"][data-mode="system"]`);
    }
  });

  it('every voice defines the type-scale vars; Mono --note is 16px (iOS no-zoom rule)', () => {
    for (const v of VOICES) {
      const block = voiceBlock(v);
      expect(block.length, `${v} voice block`).toBeGreaterThan(0);
      for (const sv of SCALE_VARS) {
        expect(block, `${v} missing ${sv}`).toContain(`${sv}:`);
      }
    }
    // iOS Safari zooms a focused contenteditable < 16px → Mono body must be 16px, not the packet's 15px.
    expect(voiceBlock('mono')).toMatch(/--note:\s*16px/);
  });

  it('cross-theme invariants are present', () => {
    expect(css).toMatch(/\.dt-sync-dot[^}]*background:\s*var\(--sync\)/); // sync dot always --sync
    expect(css).toMatch(/\.dt-wordmark-delta[^}]*font-family:\s*'Newsreader'/); // δ always Newsreader
    expect(css).toMatch(/\.dt-meta[^}]*font-family:\s*var\(--mono\)/); // metadata always Plex Mono
    expect(css).toMatch(/mark[^}]*color-mix\(in srgb, var\(--accent\) 24%/); // highlight = accent 24%
  });

  it('precaches the everyday faces + the always-loaded δ subset; lazy Serif/Grotesk faces stay out', () => {
    expect(css).toContain("src:url('/fonts/ibm-plex-sans-400.woff2')");
    expect(css).toContain("src:url('/fonts/ibm-plex-mono-400.woff2')");
    // Lane 5: the δ-wordmark subset is always-loaded (brand invariant) and legitimately references a
    // newsreader woff2, scoped to U+03B4 so it only ever paints δ.
    expect(css).toContain('newsreader-delta.woff2');
    expect(css).toMatch(/unicode-range:\s*U\+03B4/i);
    // The FULL Serif faces + Space Grotesk live in the LAZY chunks, never in the always-loaded tokens.css.
    expect(css).not.toContain('newsreader-400.woff2');
    expect(css).not.toContain('newsreader-600-italic.woff2');
    expect(css).not.toContain('space-grotesk');
  });
});

describe('lazy voice chunks — full faces live off the always-loaded sheet', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
  it('newsreader.css carries the full Serif faces (normal + italic)', () => {
    const nr = read('../src/styles/fonts/newsreader.css');
    expect(nr).toContain('newsreader-600.woff2');
    expect(nr).toContain('newsreader-600-italic.woff2');
  });
  it('space-grotesk.css carries the full Grotesk faces', () => {
    const sg = read('../src/styles/fonts/space-grotesk.css');
    expect(sg).toContain('space-grotesk-700.woff2');
  });
});
