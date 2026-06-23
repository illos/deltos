import type { FormulaType, FormulaOutput } from '../formula/formulaTypes.js';

/**
 * The HEXCOLOR formula type (docs/specs/inline-formulas.md) — formula type #2, the cheap proof-of-
 * generality. Output kind = VISUAL: a colored swatch chip (deterministic, NO state, re-renders on edit) —
 * distinct from math's text/number output, proving renderOutput's element-genericity.
 *
 * Entry: the EXPLICIT bracket path — '[#FF5733]' / '[#abc]' → swatch. (Bare auto-detect is deferred: the
 * framework's consume-a-trigger-char autoTrigger doesn't fit a self-completing hex token without either
 * eating a trailing char or a non-consuming-trigger framework generalization — a separate follow-up.)
 *
 * SECURITY: the spec is gated by a STRICT hex regex before it ever reaches `style.backgroundColor`, so no
 * non-hex value (url(), expression(), etc.) can be injected via the swatch color.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

/** Validate + normalize to a lowercase #rrggbb (3-digit expanded), or null if not a hex color. */
export function normalizeHex(raw: string): string | null {
  const t = raw.trim();
  if (HEX6.test(t)) return t.toLowerCase();
  if (HEX3.test(t)) {
    const r = t[1]!, g = t[2]!, b = t[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

export const hexColorType: FormulaType = {
  id: 'hexcolor',

  // No autoTrigger — entry is the explicit bracket path (see the module note).
  recognize: (content) => {
    const t = content.trim();
    return HEX6.test(t) || HEX3.test(t) ? t : null; // store the spec as typed; normalize at render
  },

  evaluate: (spec): FormulaOutput => {
    const norm = normalizeHex(spec);
    return norm ? { ok: true, display: norm } : { ok: false };
  },

  // Output DOM: a small filled swatch in the color (the VISUAL output kind). Invalid hex → subtle '?'.
  renderOutput: (spec, output) => {
    const wrap = document.createElement('span');
    wrap.contentEditable = 'false';
    const norm = normalizeHex(spec);
    if (output.ok && norm) {
      wrap.className = 'formula-output formula-output--hexcolor';
      wrap.append(' ');
      const swatch = document.createElement('span');
      swatch.className = 'formula-swatch';
      swatch.style.backgroundColor = norm; // norm is a strict-regex-validated hex → no injection
      wrap.appendChild(swatch);
    } else {
      wrap.className = 'formula-output formula-output--hexcolor formula-output--error';
      wrap.textContent = ' ?';
    }
    return wrap;
  },
};
