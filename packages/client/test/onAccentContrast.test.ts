/**
 * a11y #64 — content on var(--accent) must clear WCAG 3:1 (non-text UI contrast) for EVERY palette×mode
 * the Appearance picker can select. White clears 6 of 8 accents; the bone-dark + ember-dark accents are
 * light enough that white drops below 3:1, so those combos override --on-accent to a near-black. This
 * test computes the effective on-accent glyph contrast for all 8 combos and proves each clears 3:1, and
 * pins the token wiring in tokens.css.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/theme/tokens.css'), 'utf8');

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255;
  const f = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch(0)) + 0.7152 * f(ch(2)) + 0.0722 * f(ch(4));
}
function ratio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE = '#FFFFFF';
const NEAR_BLACK = '#1A1410';
// accent + the effective --on-accent for each palette×mode (white default; near-black for the 2 overrides).
const COMBOS: Array<[string, string, string]> = [
  ['bone light',     '#A8662F', WHITE],
  ['bone dark',      '#C98A4A', NEAR_BLACK],
  ['graphite light', '#3B5BDB', WHITE],
  ['graphite dark',  '#5B7BFF', WHITE],
  ['manila light',   '#9E3B2E', WHITE],
  ['manila dark',    '#C75A48', WHITE],
  ['ember light',    '#EE431C', WHITE],
  ['ember dark',     '#FF6242', NEAR_BLACK],
];

describe('a11y #64 — on-accent glyph clears WCAG 3:1 everywhere', () => {
  for (const [name, accent, onAccent] of COMBOS) {
    it(`${name}: effective glyph ${onAccent} on ${accent} >= 3:1`, () => {
      expect(ratio(onAccent, accent)).toBeGreaterThanOrEqual(3);
    });
  }

  it('the two overridden combos are exactly the ones where WHITE fails 3:1', () => {
    for (const [name, accent, onAccent] of COMBOS) {
      const whiteFails = ratio(WHITE, accent) < 3;
      expect(onAccent === NEAR_BLACK, `${name} override matches white-failure`).toBe(whiteFails);
    }
  });
});

describe('a11y #64 — token wiring in tokens.css', () => {
  it(':root declares the white default', () => {
    expect(tokens).toMatch(/:root\s*\{[\s\S]*?--on-accent:\s*#fff/i);
  });
  it('bone-dark + ember-dark (explicit AND system) override to the near-black', () => {
    // 2 explicit dark blocks + 2 system-dark blocks = 4 overrides total.
    const overrides = tokens.match(/--on-accent:\s*#1A1410/gi) ?? [];
    expect(overrides.length).toBe(4);
  });
});
