# Inline formula framework — spec & roadmap (DESIGN IN PROGRESS)

Status: **SHIPPED — framework + math + hexcolor live 2026-06-24; dice deferred (future TTRPG plugin,
not scheduled).** Owner: navSys-2 (planner). Promotes the shipped inline-math feature
(`docs/specs/inline-math.md`, LIVE) from a one-off into the **first consumer of an inline-formula
framework**. Same plugin/registry pattern as the embeds plugin + the Deck loadouts,
applied to inline expressions. Related: `[[slash-palette-block-shard-architecture]]`,
`[[ui-view-driven-architecture]]`, `[[custom-keyboard-direction]]` (Deck loadouts/context).

## 0. The reframe (Jim, 2026-06-23)

> "It's really an inline FORMULA framework, and the math is the first consumer. Once you detect the
> formula (by the same methods — `=` preceding a numerical value, etc.) that converts the whole
> string into a formula that is now **durable until deleted**. With simple math the output is a
> simple numerical value, but other formulas can have different output types — e.g. an inline DICE
> formula `2d10 + 2` whose output isn't a number but an inline generated result that re-rolls fresh
> every time you hit the generate button. Formulas auto-detect, but are also manually defined via a
> new delimiter — `[...]` — where anything between the brackets is treated as a formula and resolved
> against a list of known formulas based off the active plugin loadout."

So: **inline-math is not the thing — it's the first TYPE in a framework.** Promote it.

## 1. The framework

- A **formula** = a durable inline construct carrying a **TYPE** (`math`, `dice`, …). Once created
  it persists until deleted (the shipped math chip already behaves this way — we generalize it).
- A **registry of formula TYPES**, each a plugin declaring:
  1. **parse/recognize** — does this string match my formula? (+ its auto-detect trigger)
  2. **evaluate** — compute the output from the spec.
  3. **render output** — and the OUTPUT KIND differs by type:
     - **math** → a STATIC DERIVED value: recomputes when the spec is edited; deterministic.
     - **dice** (`2d10 + 2`) → a GENERATED-ON-DEMAND result + a **re-roll button**; each press =
       a fresh stochastic roll. NOT derived-from-input; interactive; carries state (the last roll).
- **Two entry paths:**
  - **AUTO-DETECT** (per type): math = `=` after a numeric expression (current); dice = the `NdM[±k]`
    pattern. Each type registers its own auto-trigger.
  - **EXPLICIT `[...]`**: typing a bracketed expression resolves its content against the loadout's
    known formula types → becomes a formula if one matches. The unambiguous, extensible entry path.
- **Loadout-scoped resolution** (Jim): which formula types are "known" depends on the **active
  plugin loadout** — math in the default set; dice in a TTRPG loadout; future types elsewhere.
  Dovetails with the Deck's context-driven-surface direction.

## 2. Architecture consequence — formula NODE, not math's mark+decoration

The shipped math uses a text **mark + live decoration** (fine for a static number). **Dice needs
interactive UI (a re-roll button) + stochastic state (the last roll)** → mark+decoration won't carry
that. So the framework wants a generic **inline formula NODE** with a **type-dispatched NodeView**
(renders the per-type output, incl. interactive widgets). Math **refactors onto this node** as the
first registered type (behavior-preserving — math keeps working exactly as it does live). Inline node
mechanism mirrors how E2b mounted a React NodeView (the embeds card pattern), but inline not block.
Persistence: store the formula SPEC + TYPE (+ type-specific state like dice's last roll) — rides the
spine round-trip, no migration (open `BlockType`/inline-mark precedent).

## 3. Consumers — math (built) + dice (illustrative, deferred)

- **`math`** (LIVE today; refactor into the framework — the ONLY built consumer in Phase 1): spec =
  the arithmetic expression; output = static derived number; recompute on edit; div0 → subtle error.
  Engine already exists (`src/plugins/math/`); becomes the first formula-type plugin. The refactor is
  BEHAVIOR-PRESERVING — math must keep working exactly as live (the existing math tests + Jim's
  confirmed Deck behavior are the regression gate).
- **`dice`** (DESIGN-VALIDATION CASE — NOT built; future wider TTRPG plugin per Jim): spec = dice
  notation (`NdM ± k`); output = a rolled total + re-roll button, fresh each press, persists the last
  roll; safe RNG (no eval). Its job NOW is to keep the framework HONEST — the abstraction (varying
  output kind, on-demand+stateful output, loadout-scoped resolution) must accommodate it without a
  redesign. Build the framework so registering dice later is purely additive; don't build dice.
- **`hexcolor`** (candidate SECOND consumer — Jim 2026-06-23): spec = a hex color (`#FF5733` /
  `#RGB`); output = a properly **colored swatch chip** (the color rendered). Adds a third OUTPUT
  KIND — VISUAL/presentational (not a number, not interactive) — and it's deterministic like math
  (recompute/re-render on edit, no state). **Cheap + broadly useful + non-TTRPG**, so unlike dice it's
  a strong candidate to actually SHIP as the framework's second real type — the lowest-cost proof
  that the abstraction is genuinely general (a framework with one consumer isn't proven). Proposed as
  an optional Phase-1.5 once the framework + math land; Jim to confirm build-vs-illustrative.

**Output-kind taxonomy the render contract must support** (keeps the abstraction honest, not
math-shaped): (1) DERIVED-STATIC — a computed value, recompute on edit (math); (2) VISUAL — a
rendered representation of the spec, re-render on edit (hexcolor swatch); (3) GENERATED-INTERACTIVE —
on-demand + stateful + a control (dice re-roll). The type's `render-output` must be able to produce
an arbitrary element (text, swatch, or interactive widget), NOT just a text/number string.

## 4. DECISIONS (LOCKED with Jim 2026-06-23)

1. ✅ **`[...]` resolution:** resolve on the closing `]` — try the loadout's formula parsers; if one
   matches → formula; if none → leave as literal text (`[note to self]` stays plain). Same
   "don't fire on non-matches" discipline as math's `=`.
2. ✅ **Dice output + persistence:** a dice formula persists its **spec + last roll** (reopening
   shows the last result) and renders the result + a re-roll button (tap → fresh). Math persists
   just the spec + recomputes. (Design target — dice not built now; see §3.)
3. ✅ **Math keeps BOTH entry paths** — its `=` auto-detect AND `[1+1]`.
4. ✅ **Dice/TTRPG is illustrative, NOT a build-now (Jim):** dice is just an EXAMPLE consumer to
   prove the framework's generality; "if we ever build it, it'll be part of a wider TTRPG plugin."
   So: do NOT build dice now and do NOT formalize a "TTRPG loadout." Build the registry
   loadout-AWARE (so a future TTRPG plugin can register dice + scope it) but ship with math as the
   only built type. The framework MUST be DESIGNED so dice drops in cleanly later (varying output
   kind / on-demand+stateful / loadout-scoped) — dice is the design-validation case, not a deliverable.
5. Re-roll affordance shape + per-die breakdown = a future-dice detail; ignore for now.

## 5. Sequencing

- **Phase 1 — framework + math refactor:** build the inline-formula node + type registry + the two
  entry paths (auto-detect adapter + the `[...]` input rule), and move math onto it as the first
  type. Behavior-preserving (math stays identical for Jim). Owner: devSys (it built the math
  engine/integration). MUST dual-wire the `[...]`/auto triggers into the deckAdapter (the keypad
  bypasses input-rules — `[[deck-keypad-bypasses-inputrules-keymap]]`).
- **Dice — DEFERRED (future TTRPG plugin, not scheduled):** registered as a formula type if/when Jim
  builds the wider TTRPG plugin. Design Phase 1 against it (the abstraction must accommodate it) but
  do NOT build it. So Phase 1 IS the whole current deliverable: the framework + math on it.
- This `docs/specs/inline-formulas.md` supersedes the standalone framing in `inline-math.md` (kept
  for the shipped math detail/history).
