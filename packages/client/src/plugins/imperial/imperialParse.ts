/**
 * Imperial-units parser + formatter (PURE input→output; no DOM, no ProseMirror) — the core of the imperial
 * formula type (docs/specs/inline-formulas.md). Adds a whitespace/comma-separated list of imperial
 * measurements written the way a carpenter jots them, e.g. `Trim: 12, 123” 4 4’5” 12-15/16” 12’6”`, and
 * renders the SUM as feet + inches rounded UP to the nearest 1/32", e.g. `44′ 2-15/16″`.
 *
 * Unit marks are accepted BOTH straight and curly, because iOS auto-smart-quotes rewrites ' and " to the
 * typographic ’ ” — and a carpenter may also type the true prime marks ′ ″:
 *   feet:   ' ’ ‘ ′      inches: " ” “ ″
 *
 * ADD-ONLY: there are no negative values; a '-' is ONLY a whole/fraction separator (`12-15/16`).
 */

import { bindRefs, extractLabel, REF_OPEN, REF_CLOSE } from '../formula/refBinding.js';

/** Feet-mark characters (straight apostrophe, curly quotes, prime). */
const FEET_MARKS = /[’‘′']/g;
/** Inch-mark characters (straight quote, curly quotes, double-prime). */
const INCH_MARKS = /[”“″"]/g;

/** A bound-reference sentinel token (`<index>`, refBinding.ts) — the ONE reference production
 *  (formula-engine.md §6): it resolves to a raw value in INCHES (imperial's canonical unit), explicitly
 *  NOT the bare-number-means-feet literal. */
const SENTINEL_RE = new RegExp(`^${REF_OPEN}(\\d+)${REF_CLOSE}$`);

export interface ImperialParse {
  /** The summed value of every token, in inches. */
  readonly totalInches: number;
  /** Was a leading `word:` label present? (recognize() gating — a label alone marks intent.) */
  readonly hasLabel: boolean;
  /** Did at least one token carry a feet/inch mark? (recognize() gating — disjoint from math.) */
  readonly hasMark: boolean;
}

/**
 * Parse a single "measure" — the numeric part of a token, in ONE unit:
 *   integer `12` · decimal `4.5` · whole-plus-fraction `12-15/16` · bare fraction `15/16`.
 * Returns the numeric value, or null if it isn't a well-formed measure. No sign is accepted (add-only).
 */
function parseMeasure(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  let m: RegExpExecArray | null;
  // whole-plus-fraction: 12-15/16  (the '-' separates whole from fraction, SAME unit)
  if ((m = /^(\d+)-(\d+)\/(\d+)$/.exec(t))) {
    const den = Number(m[3]);
    if (den === 0) return null;
    return Number(m[1]) + Number(m[2]) / den;
  }
  // bare fraction: 15/16
  if ((m = /^(\d+)\/(\d+)$/.exec(t))) {
    const den = Number(m[2]);
    if (den === 0) return null;
    return Number(m[1]) / den;
  }
  // integer or decimal: 12 · 4.5
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return null;
}

interface Token {
  readonly inches: number;
  readonly hasMark: boolean;
}

/**
 * Parse ONE token to a value in inches. A token is an optional feet-part and an optional inch-part:
 *   `4’5”`       → 4 ft + 5 in            (both marks)
 *   `1/2’`       → 0.5 ft                  (feet mark only)
 *   `123”` `12-15/16”` → inches            (inch mark only)
 *   `12` `4`     → FEET                     (no mark at all → the number is feet)
 * Returns null if the token is malformed (so the caller can decline the whole spec).
 */
function parseToken(raw: string, resolveIndex?: (index: number) => number | null): Token | null {
  const t = raw.trim();
  if (t === '') return null;
  // Reference sentinel → the bound value, already in INCHES (never the feet default). A reference does
  // not count as a unit mark (the recognize gate stays label-or-mark).
  const ref = SENTINEL_RE.exec(t);
  if (ref) {
    const v = resolveIndex ? resolveIndex(Number(ref[1])) : null;
    if (v === null || !Number.isFinite(v)) return null; // unresolved reference → the whole spec declines
    return { inches: v, hasMark: false };
  }
  // Canonicalize every feet/inch glyph to the straight ' / " so the structural parse is single-case.
  const norm = t.replace(FEET_MARKS, "'").replace(INCH_MARKS, '"');
  const hasFeetMark = norm.includes("'");
  const hasInchMark = norm.includes('"');

  if (!hasFeetMark && !hasInchMark) {
    // No mark → the bare number is FEET.
    const measure = parseMeasure(norm);
    if (measure === null) return null;
    return { inches: measure * 12, hasMark: false };
  }

  let feetMeasure = 0;
  let inchMeasure = 0;
  let rest = norm;

  if (hasFeetMark) {
    const idx = norm.indexOf("'");
    const fm = parseMeasure(norm.slice(0, idx));
    if (fm === null) return null;
    feetMeasure = fm;
    rest = norm.slice(idx + 1); // whatever follows the feet mark (an inch part, or nothing)
  }

  if (hasInchMark) {
    // The remainder must be exactly `<measure>"` — anything else is malformed.
    if (!rest.endsWith('"')) return null;
    const im = parseMeasure(rest.slice(0, -1));
    if (im === null) return null;
    inchMeasure = im;
    rest = '';
  }

  // A feet mark with a trailing bare number but no inch mark (e.g. `4'5`) is ambiguous → reject.
  if (rest !== '') return null;

  return { inches: feetMeasure * 12 + inchMeasure, hasMark: true };
}

/**
 * Parse a full imperial spec: strip an optional leading label (the SHARED substrate extraction —
 * refBinding.extractLabel, lifted out of this file in Step 2, semantics identical), bind any `[Ref]`
 * tokens to sentinels, split the remainder on commas/whitespace, parse + sum every token (accumulating in
 * INCHES so feet convert exactly via ×12). Returns the total plus the two gating flags, or null if there
 * are no tokens or ANY token is malformed.
 *
 * `resolveRef` resolves a reference NAME to a raw scalar in INCHES (the engine's NumericEnv seam). Omit it
 * (every pre-Step-2 caller) and a spec containing references simply declines — ref-free specs behave
 * exactly as before.
 */
export function parseImperial(
  content: string,
  resolveRef?: (name: string) => number | null,
): ImperialParse | null {
  const { label, body } = extractLabel(content);
  const hasLabel = label !== null;
  const { skeleton, refs } = bindRefs(body);
  const resolveIndex = (index: number): number | null => {
    const name = refs[index];
    return name === undefined || !resolveRef ? null : resolveRef(name);
  };

  const tokens = skeleton.split(/[,\s]+/).filter((s) => s.length > 0);
  if (tokens.length === 0) return null;

  let totalInches = 0;
  let hasMark = false;
  for (const tok of tokens) {
    const parsed = parseToken(tok, resolveIndex);
    if (parsed === null) return null;
    totalInches += parsed.inches;
    hasMark = hasMark || parsed.hasMark;
  }

  return { totalInches, hasLabel, hasMark };
}

/** Reduce n/32 to lowest terms (n in 1..31) → e.g. 30/32 → "15/16", 8/32 → "1/4", 1/32 → "1/32". */
function reduceThirtySeconds(frac32: number): string {
  let num = frac32;
  let den = 32;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return `${num}/${den}`;
}

const FOOT = '′'; // ′ PRIME
const INCH = '″'; // ″ DOUBLE PRIME

/**
 * Format a total (in inches) as feet + inches rounded UP to the nearest 1/32":
 *   530.9375 → `44′ 2-15/16″`,  6 → `6″`,  16 → `1′ 4″`,  0.9375 → `15/16″`,  0 → `0″`.
 *
 * The ceil is nudged DOWN by a 1e-9 epsilon so a value that is EXACTLY on a 1/32 boundary but carries a
 * tiny binary-float excess (e.g. 15/16 stored as 0.9375000000001) does not spuriously round up to 31/32.
 */
export function formatInches(totalInches: number): string {
  const total32 = Math.ceil(totalInches * 32 - 1e-9);
  const feet = Math.floor(total32 / 384); // 384 = 32 × 12
  const rem = total32 % 384;
  const wholeInches = Math.floor(rem / 32);
  const frac32 = rem % 32;

  const fracStr = frac32 > 0 ? reduceThirtySeconds(frac32) : '';
  const hasFrac = fracStr !== '';

  const feetPart = feet > 0 ? `${feet}${FOOT}` : '';

  let inchPart = '';
  if (wholeInches > 0) {
    inchPart = `${wholeInches}${hasFrac ? '-' + fracStr : ''}${INCH}`;
  } else if (hasFrac) {
    inchPart = `${fracStr}${INCH}`; // pure fraction — no leading dash
  }

  if (feetPart === '' && inchPart === '') return `0${INCH}`;
  return [feetPart, inchPart].filter((p) => p !== '').join(' ');
}
