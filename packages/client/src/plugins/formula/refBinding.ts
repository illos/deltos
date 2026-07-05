/**
 * Reference BINDING + shared LABEL extraction (docs/specs/formula-engine.md §6, Step 2) — the pure
 * substrate-common piece both numeric grammars and the host environment share. No ProseMirror, no DOM,
 * no engine imports: this file is EAGER (it rides the editor chunk with the numeric types), so it must
 * stay tiny and dependency-free.
 *
 * Two substrate-common concepts live here:
 *
 * 1. THE LABEL — the optional leading `Word:` tag of a numeric spec (`[Y: 2+2]`, `[Trim: 12 4'6"]`),
 *    lifted OUT of imperial-only parsing (Step-2 locked decision #1): BOTH math and imperial carry it.
 *    The label (a) stays visible in the editable spec as a tag — it never affects the arithmetic — and
 *    (b) PUBLISHES the formula's reference name (the label string IS the reference key; the host's
 *    LabelIndex groups formulas by it).
 *
 * 2. THE REFERENCE TOKEN — a bracketed label-shaped occurrence inside a spec (`12 x [Y] / 2`). Reference
 *    tokens are single-level by construction (no brackets inside a name). {@link bindRefs} replaces each
 *    with an indexed SENTINEL (private-use-area delimiters survive both grammars' tokenization — imperial
 *    splits on whitespace and a name may contain spaces, so the sentinel, not the name, goes in the
 *    skeleton) and returns the ordered names. Each grammar gains exactly ONE production — sentinel →
 *    `env.resolveRef(name)` as a raw scalar in the type's canonical unit (locked decision #2/#5).
 *
 * `[Label:total]` is an explicit synonym for the bare `[Label]` (Step-2 locked decision #4): the `:total`
 * suffix is normalized away HERE — before any name reaches the label resolver — so `[J:total]` and `[J]`
 * are the same reference token by construction.
 */

/** Sentinel delimiters (Unicode private-use area — cannot occur in real user specs; a pasted PUA char
 *  simply fails both grammars, same as any unknown character). The skeleton form is `<index>`. */
export const REF_OPEN = '\uE000';
export const REF_CLOSE = '\uE001';

/** A leading `word:` label — letters then letters/digits/spaces, ending in a colon. A token that STARTS
 *  with a digit (a time like `3:30`) is deliberately NOT a label. Shared verbatim with what imperial's
 *  parser matched pre-lift (behavior-preserving). */
const LABEL_RE = /^\s*([A-Za-z][A-Za-z0-9 ]*):\s*/;

/** A reference token's inner text: a label-shaped name, optionally suffixed `:total` (the explicit
 *  totalizer synonym). Lazy name so the optional suffix + trailing spaces aren't swallowed by the class. */
const REF_TOKEN_RE = /^([A-Za-z][A-Za-z0-9 ]*?)\s*(?::\s*total\s*)?$/i;

export interface LabeledSpec {
  /** The published label (trimmed), or null when the spec carries none. */
  readonly label: string | null;
  /** The spec with the label tag removed — what the arithmetic grammar actually parses. */
  readonly body: string;
}

/** Split the optional leading `Label:` tag off a spec. The label never affects the math — it only names
 *  the formula (the host publishes it into the LabelIndex). */
export function extractLabel(spec: string): LabeledSpec {
  const m = LABEL_RE.exec(spec);
  if (!m) return { label: null, body: spec };
  return { label: m[1]!.trim(), body: spec.slice(m[0].length) };
}

/**
 * Normalize a reference token's inner text to its reference NAME, or null when it isn't label-shaped
 * (so `[1 + 1]` inside a spec is NOT a reference — it stays literal text and the grammar declines it).
 * Normalization = trim + strip the `:total` synonym (decision #4: `[J:total]` ≡ `[J]`).
 */
export function refTokenName(raw: string): string | null {
  const m = REF_TOKEN_RE.exec(raw.trim());
  return m ? m[1]!.trim() : null;
}

export interface BoundRefs {
  /** The spec with every reference token replaced by an indexed sentinel — reference-free for the grammar. */
  readonly skeleton: string;
  /** The ordered, NORMALIZED reference names ([i] backs sentinel i). Duplicates keep separate sentinels
   *  but the same name — the environment binds by name, so they share one value. */
  readonly refs: readonly string[];
}

/** Any single-level bracketed run (reference tokens have no nested brackets by construction). */
const BRACKET_RUN_RE = /\[([^[\]]*)\]/g;

/**
 * The shared reference BINDER (§6 step 1): find the `[Name]` reference tokens in a spec body, replace each
 * with `<index>`, and return the skeleton + the ordered names. A bracketed run that is NOT
 * label-shaped is left literally in place (the grammar then fails on the `[` — a quiet decline, never a
 * bogus reference).
 */
export function bindRefs(body: string): BoundRefs {
  const refs: string[] = [];
  const skeleton = body.replace(BRACKET_RUN_RE, (whole, inner: string) => {
    const name = refTokenName(inner);
    if (name === null) return whole;
    refs.push(name);
    return `${REF_OPEN}${refs.length - 1}${REF_CLOSE}`;
  });
  return { skeleton, refs };
}
