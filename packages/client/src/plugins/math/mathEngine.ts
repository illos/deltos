/**
 * Inline-math ENGINE (docs/specs/inline-math.md §2) — a SAFE arithmetic evaluator + the "=" trigger
 * predicate. Pure logic, ZERO ProseMirror/editor types, so the editor integration (input rule +
 * code-mark/decoration + live recompute, a follow-on) layers on top without touching this.
 *
 * 🔒 SECURITY: there is NO eval() / new Function() / dynamic code execution anywhere — a user string is
 * NEVER executed. A hand-written tokenizer + recursive-descent parser computes the value. This is the
 * whole reason a real parser exists (eval would be a code-injection hole).
 *
 * Grammar (standard precedence, * / before + -; unary minus; parentheses):
 *   expression := term   (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := ('+' | '-') factor | number | '(' expression ')'
 */

/** Result of {@link evaluate}: a clean numeric value, or a non-throwing failure with a reason. */
export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

type Token =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: '(' }
  | { t: ')' };

/** Internal control-flow signal for a parse/eval failure — caught at the {@link evaluate} boundary. */
class MathError extends Error {}

/**
 * Tokenize an arithmetic string. Returns null on any unrecognized character (the caller reports
 * malformed). Operator aliases: `x`/`X`/`×` → multiply, `÷` → divide (supersets of Jim's `x`).
 */
function tokenize(s: string): Token[] | null {
  const toks: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      let dotSeen = false;
      while (j < s.length && ((s[j]! >= '0' && s[j]! <= '9') || s[j] === '.')) {
        if (s[j] === '.') { if (dotSeen) return null; dotSeen = true; }
        j++;
      }
      const numStr = s.slice(i, j);
      if (numStr === '.') return null; // a lone dot is not a number
      const v = Number(numStr);
      if (!Number.isFinite(v)) return null;
      toks.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (c === '+' || c === '-') { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '*' || c === 'x' || c === 'X' || c === '×') { toks.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === '/' || c === '÷') { toks.push({ t: 'op', v: '/' }); i++; continue; }
    if (c === '(') { toks.push({ t: '(' }); i++; continue; }
    if (c === ')') { toks.push({ t: ')' }); i++; continue; }
    return null; // unknown character
  }
  return toks;
}

/**
 * Kill floating-point noise: round to 12 significant digits then back to a Number, so
 * 1 + 4 - 2 / 10 → 4.8 (not 4.7999999999), 10 x 2 → 20, and trailing zeros vanish (Number drops them).
 */
function clean(n: number): number {
  return Number(n.toPrecision(12));
}

/**
 * Evaluate an arithmetic expression. Never throws: malformed input, an unknown character, trailing
 * tokens, division by zero, and non-finite results all return `{ ok: false }`.
 */
export function evaluate(expr: string): EvalResult {
  const toks = tokenize(expr);
  if (toks === null) return { ok: false, error: 'unrecognized character' };
  if (toks.length === 0) return { ok: false, error: 'empty expression' };

  let pos = 0;
  const peek = (): Token | undefined => toks[pos];
  const advance = (): Token => toks[pos++]!;

  const parseExpression = (): number => {
    let val = parseTerm();
    for (let t = peek(); t && t.t === 'op' && (t.v === '+' || t.v === '-'); t = peek()) {
      const op = advance() as { t: 'op'; v: '+' | '-' };
      const rhs = parseTerm();
      val = op.v === '+' ? val + rhs : val - rhs;
    }
    return val;
  };
  const parseTerm = (): number => {
    let val = parseFactor();
    for (let t = peek(); t && t.t === 'op' && (t.v === '*' || t.v === '/'); t = peek()) {
      const op = advance() as { t: 'op'; v: '*' | '/' };
      const rhs = parseFactor();
      if (op.v === '*') { val = val * rhs; }
      else { if (rhs === 0) throw new MathError('division by zero'); val = val / rhs; }
    }
    return val;
  };
  const parseFactor = (): number => {
    const t = peek();
    if (!t) throw new MathError('unexpected end of expression');
    if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
      advance();
      const f = parseFactor();
      return t.v === '-' ? -f : f;
    }
    if (t.t === 'num') { advance(); return t.v; }
    if (t.t === '(') {
      advance();
      const v = parseExpression();
      const close = peek();
      if (!close || close.t !== ')') throw new MathError('unbalanced parentheses');
      advance();
      return v;
    }
    throw new MathError('unexpected token');
  };

  try {
    const v = parseExpression();
    if (pos !== toks.length) return { ok: false, error: 'trailing tokens' };
    if (!Number.isFinite(v)) return { ok: false, error: 'result is not finite' };
    return { ok: true, value: clean(v) };
  } catch (e) {
    return { ok: false, error: e instanceof MathError ? e.message : 'parse error' };
  }
}

// The characters that can belong to an arithmetic run (the trailing-expression scan set). Anything else
// (a letter, ':', etc.) bounds the run. `x`/`X` count (multiply alias) so "10 x 2" scans as one run.
const ARITH_CHAR = /[0-9.\s+\-*/xX×÷()]/;
// Operator characters (for the ≥1-binary-operator requirement).
const OP_CHAR = /[+\-*/xX×÷]/g;

/**
 * The "=" trigger predicate (docs/specs/inline-math.md §2). Returns the maximal TRAILING arithmetic run
 * in `textBeforeCaret` when one is a real computation, else null. "Real computation" = at least one
 * BINARY operator (a lone leading unary sign like "-5" does NOT qualify) AND it parses ({@link evaluate}
 * ok). This fires anywhere inline on a valid numeric tail ("I paid 10 x 2" → "10 x 2") but never on prose
 * ("name = value", "x = y" → null — their tails are letters). Tunable: the scan set + the binary-op
 * threshold are the fork-1 sensitivity knobs.
 */
export function detectTrailingExpression(textBeforeCaret: string): string | null {
  let i = textBeforeCaret.length;
  while (i > 0 && ARITH_CHAR.test(textBeforeCaret[i - 1]!)) i--;
  const run = textBeforeCaret.slice(i).trim();
  if (run.length === 0) return null;

  // Require ≥1 BINARY operator: discount a single leading unary +/- so "-5" / "+3" alone don't trigger.
  const opCount = (run.match(OP_CHAR) ?? []).length;
  const leadingUnary = /^[+-]/.test(run) ? 1 : 0;
  if (opCount - leadingUnary < 1) return null;

  return evaluate(run).ok ? run : null;
}
