# Inline math completion — spec & roadmap

> **Historical — v1 shipped 2026-06-24. Superseded by `docs/specs/inline-formulas.md`, which promotes
> inline-math into the first consumer of the inline-formula framework. This file is kept for the
> shipped math detail and history.**

Status: **SHIPPED — inline-math live 2026-06-24; see inline-formulas.md for the framework spec** — engine (design-independent) dispatched to devSys;
editor-integration forks pending Jim. Owner: navSys-2 (planner). This is the **second editor
plugin/shard** (inline variant) — reinforces the plugin architecture stood up by rich embeds
(`[[slash-palette-block-shard-architecture]]`, #62). Lives in `src/plugins/math/`.

## 0. Jim's vision (2026-06-23)

Inline live-math: simple arithmetic auto-completes as you type. Examples:
```
1 + 1 = 2
10 / 10 = 1
10 x 2 = 20
1 + 4 - 2 / 10 = 4.8        ← multi-step, STANDARD PRECEDENCE (÷ before −): 1+4−0.2 = 4.8
```
Trigger (Jim): **typing `=` landing in front of an arithmetic expression** (containing `x / - +`
etc.) fires it → **wraps the expression in `<>` code tags** → computes + shows the result after
`=`. Once fired, **editing the math updates the result live**.
(Note: `10 / 10` = 1, not 2 — typo in Jim's note; the engine computes correctly. `x` = multiply.)

## 1. Behavior

- **Trigger:** the user types `=` immediately after a trailing arithmetic expression → the plugin
  recognizes the expression, styles it as inline code, and appends the computed result.
- **Operators:** `+  -  x  *  /` (both `x` and `*` = multiply), decimals, **standard precedence**
  (`* / x` before `+ -`) — confirmed by the `4.8` example. (Parens / negatives = OPEN, fork 4.)
- **Live:** editing the expression recomputes the result (cheap → on edit).
- **Persistence:** store the EXPRESSION (source of truth); recompute the result on render (always
  correct; engine can improve). Rides the plugin/spine round-trip (no migration — same as the card).

## 2. ENGINE (design-independent — DISPATCHED to devSys now, TDD)

A **safe arithmetic evaluator** — `src/plugins/math/` pure logic, zero editor/PM types:
- `evaluate(expr): { ok: true, value } | { ok: false, error }` — tokenize → parse → eval. Support
  `+ - * (x) /`, decimals, negative numbers, parentheses, **standard precedence**. **FORMAT** the
  result to kill float noise (`4.8`, not `4.7999999`; trim trailing zeros; sensible sig-digits).
- 🔒 **HARD SECURITY RULE: NEVER `eval()` / `Function()` / any dynamic code exec** on the user
  string — a hand-written tokenizer + recursive-descent (or shunting-yard) parser ONLY. (eval would
  be a code-injection hole; secSys would reject it.) This is the whole reason for a real parser.
- `detectTrailingExpression(textBeforeCaret): string | null` — returns the trailing arithmetic run
  if one exists (≥1 operator, all-numeric operands, parseable), else null. This is the trigger
  predicate; tuning it is fork 1 (avoid firing on prose like `x = y` / `total =`).
- Div-by-zero / malformed → `{ ok:false }` (no crash). TDD: Jim's 4 examples + precedence +
  decimals + negatives + parens + div-by-zero + malformed + detection true/false (incl. prose
  negatives).

## 3. EDITOR INTEGRATION (forks pending Jim — §4)

Mechanism TBD at build, two options (build team picks, scout-informed):
- **(pref) code-mark + live result DECORATION:** the expression gets the existing inline `code`
  mark; a decoration plugin (same pattern as spellcheck) renders the `= result` as a derived
  widget after it, recomputing on edit. Reuses existing primitives; result stays non-editable.
- **inline math NODE:** a dedicated inline node (the block `plugin_block` is block-level; inline
  needs an inline node). More machinery.
The trigger = an input rule on `=` (core `inputRules.ts` pattern) calling `detectTrailingExpression`.

## 4. DECISIONS (LOCKED with Jim 2026-06-23)

1. ✅ **Trigger = fire-anywhere-if-valid-numeric-expression.** Typing `=` fires when the trailing
   run is a valid numeric expression with ≥1 operator (`I paid 10 x 2 =` → 20 mid-sentence works);
   silent on prose (`name = value`, `x = y` — no numeric expression).
2. ✅ **Visual = inline mono/code chip** `1 + 1 = 2`, result emphasized (bold/accent). ("<> code tags".)
3. ✅ **Exit = BACKSPACE-to-unwrap** (Jim: "let's try backspace and see how it feels" — try-and-feel).
   Backspacing through the chip converts it back to plain text. No separate x affordance for v1;
   on-device feel may revise.
4. ✅ **Operators:** `+ - x * /` + decimals + standard precedence (locked by 4.8). Engine ALSO
   supports parentheses + negatives (harmless superset). Div-by-zero/malformed → subtle error state.
5. ✅ **Re-eval = live on edit** (cheap).

## 5. Sequencing

Engine (devSys, now — TDD, no-regret). Editor integration (the input rule + code-mark/decoration +
live recompute + persistence) = a follow-on once forks lock — devSys can carry it (self-contained
`src/plugins/math/` module; low contention) or it slots with the other editor-plugin work. This is
the second concrete plugin → further validates the `src/plugins/` + registry pattern from embeds.
