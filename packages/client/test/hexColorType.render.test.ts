/**
 * Hexcolor formula type tests (docs/specs/inline-formulas.md) — formula type #2. Pure type logic
 * (recognize / normalize / evaluate) + the swatch renderOutput. The bracket-path PM integration is in
 * formulaPlugin.render.
 */
import { describe, it, expect } from 'vitest';
import { hexColorType, normalizeHex } from '../src/plugins/hexcolor/hexColorType.js';

describe('normalizeHex', () => {
  it('lowercases a 6-digit hex', () => { expect(normalizeHex('#FF5733')).toBe('#ff5733'); });
  it('expands a 3-digit hex to 6 + lowercases', () => { expect(normalizeHex('#ABC')).toBe('#aabbcc'); });
  it('trims surrounding whitespace', () => { expect(normalizeHex('  #0f0 ')).toBe('#00ff00'); });
  it('rejects non-hex / wrong length / missing #', () => {
    for (const bad of ['ff5733', '#ff57', '#gggggg', '#12345', '#1234567', 'red', '', '#']) {
      expect(normalizeHex(bad), bad).toBeNull();
    }
  });
});

describe('hexColorType', () => {
  it('auto-detects bare 6-digit hex on a non-consuming boundary (space), NOT 3-digit', () => {
    expect(hexColorType.autoTrigger?.char).toBe(' ');
    expect(hexColorType.autoTrigger?.consumesTrigger).toBe(false);
    const detect = hexColorType.autoTrigger!.detect;
    expect(detect('pick #FF5733')).toBe('#FF5733');      // trailing 6-digit at a boundary
    expect(detect('#abcdef')).toBe('#abcdef');           // start-of-line boundary
    expect(detect('#abc')).toBeNull();                   // 3-digit → bracket-only (dad/bee/fed safety)
    expect(detect('word#FF5733')).toBeNull();            // glued to a word, not at a boundary
    expect(detect('#FF5733 ')).toBeNull();               // already followed by space (not trailing)
    expect(detect('hello world')).toBeNull();            // prose
  });

  it('recognize accepts #RRGGBB and #RGB (case-insensitive), rejects others', () => {
    expect(hexColorType.recognize('#FF5733')).toBe('#FF5733'); // stored as typed
    expect(hexColorType.recognize('#abc')).toBe('#abc');
    expect(hexColorType.recognize('  #0F0 ')).toBe('#0F0');
    expect(hexColorType.recognize('1 + 1')).toBeNull();
    expect(hexColorType.recognize('#xyz')).toBeNull();
    expect(hexColorType.recognize('note')).toBeNull();
  });

  it('evaluate normalizes a valid hex, fails on invalid', () => {
    expect(hexColorType.evaluate('#ABC', null)).toEqual({ ok: true, display: '#aabbcc' });
    expect(hexColorType.evaluate('#FF5733', null)).toEqual({ ok: true, display: '#ff5733' });
    expect(hexColorType.evaluate('nope', null).ok).toBe(false);
  });

  it('renderOutput builds a swatch with the normalized color', () => {
    const ctx = { state: null, setState: () => {} };
    const el = hexColorType.renderOutput('#abc', hexColorType.evaluate('#abc', null), ctx);
    const swatch = el.querySelector('.formula-swatch') as HTMLElement | null;
    expect(swatch).not.toBeNull();
    // jsdom normalizes the inline style color; #aabbcc → rgb(170, 187, 204)
    expect(swatch!.style.backgroundColor).toBe('rgb(170, 187, 204)');
  });

  it('renderOutput shows a subtle error for an invalid hex (never crashes)', () => {
    const ctx = { state: null, setState: () => {} };
    const el = hexColorType.renderOutput('nope', hexColorType.evaluate('nope', null), ctx);
    expect(el.className).toContain('formula-output--error');
    expect(el.querySelector('.formula-swatch')).toBeNull();
  });
});
