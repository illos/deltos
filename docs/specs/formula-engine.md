# formula-engine — the shared reactive computation core

**Status:** Phase 0 (NumericFormula substrate) + Phase 1 (standalone engine) BUILT and green; editor-facing
wiring (references, totalizer grammar, nested-bracket input rule, NodeView recompute) is **Step 2**, gated
on lead review of this note.

**What this is.** Math and imperial are one family — *reduce a source string to a single scalar* — differing
only in literal grammar and output formatting (imperial's canonical unit is inches; feet are ×12/÷12 at the
I/O edges; the arithmetic is ordinary rational math). This spec grows that family into a small reactive
engine (named formulas, cross-formula references, a totalizer) that a future spreadsheet/database plugin
reuses as its compute core. The engine is **host-agnostic**: no ProseMirror, no DOM, no editor imports
anywhere under `src/formula-engine/`.

Locked decisions (with Jim): **#1** bare `[Label]` = SUM of all formulas carrying that label (unique label →
itself; `[Label:total]` = explicit synonym — one rule). **#2** cross-type mixing = raw scalars, no
dimensional analysis (the consuming type formats). **#3** order-independent resolution. **#4** cycles → a
quiet error value, never a hang. **#5** literal notation stays per-type (imperial's `12-15/16` dash collides
with subtraction — parsers are never shared; only the scalar + env layer is). **#6** values are NEVER
persisted — only spec text + `ftype` in the spine; the environment is recomputed on note open.

## 1. Layer map

```
editor (eager, in main bundle)                      lazy chunk (loaded on formula presence)
──────────────────────────────                      ─────────────────────────────────────────
formulaTypes.ts   type contract + registry          src/formula-engine/
numericFormula.ts NumericFormula substrate            value.ts          Value union
mathType.ts       mathNumeric  (grammar+format)       engine.ts         graph + incremental evaluator
imperialType.ts   imperialNumeric                     labelResolver.ts  decision #1 semantics
formulaNodeView.ts render                            [Step 2] host wiring: doc walk → nodes,
                                                       label index, coalesced recompute
```

The eager side stays what it is today — tiny type registration (the formula manifest in
`runtime/builtins.ts` remains eager). Everything reactive lives behind the lazy boundary (§8).

## 2. The NumericFormula substrate (Phase 0 — shipped)

`src/plugins/formula/numericFormula.ts`:

```ts
interface NumericEnv { resolveRef(key: string): number | null }   // EMPTY_ENV in Phase 0/1
interface NumericFormula {
  toNumber(spec: string, env: NumericEnv): number | null;  // parse to scalar, CANONICAL unit
  format(value: number): string;                            // scalar → display
}
evaluateNumeric(nf, spec, env?) → FormulaOutput             // null → { ok:false }
numericRenderOutput(typeId) → FormulaType['renderOutput']   // the shared ' = value' / ' = ?' DOM
```

`mathType` and `imperialType` are now thin shells: `mathNumeric` (evalMath / `String`) and
`imperialNumeric` (parseImperial→totalInches / formatInches). Zero observable change — proven by the
untouched existing suites. `env` is the seam the engine plugs into: a **bound reference reads as a raw
scalar in the type's own canonical unit** (an imperial spec consuming `[Y]` reads Y as *inches*, never as
the bare-number-means-feet literal). hexcolor / link-card are not numeric and are untouched.

## 3. The Value seam (Phase 1 — shipped)

```ts
type Value =
  | { kind: 'number'; value: number }                       // scalar, producing type's canonical unit
  | { kind: 'error';  code: 'cycle' | 'unresolved' | 'eval' } // quiet failure, never an exception
```

Sized for growth: a spreadsheet adds `text` / `boolean` / `array` / `range` **arms** without touching the
engine — the core never pattern-matches on `number` (it stores values, checks `valuesEqual`, and hands them
to `combine`/`compute`). Only `valuesEqual` grows a line per arm (unknown arms compare unequal → safe
over-recompute, never staleness). The engine is unit-blind per decision #2.

## 4. The engine (Phase 1 — shipped)

```ts
interface EngineNode {
  id: string;                                   // opaque host identity
  references: readonly string[];                // opaque tokens (the `Y` of `[Y]`)
  compute(refs: ReadonlyMap<string, Value>): Value;
}
interface ReferenceResolver {                   // the host-semantics seam
  resolve(ref: string, fromId: string): readonly string[];  // token → node ids (graph edges)
  combine(ref: string, values: readonly Value[]): Value;     // fold group → the ONE value the ref yields
}
createFormulaEngine(resolver): {
  setNodes(nodes)  → all values                 // note open / full rescan
  upsertNode(node) → CHANGED values only        // spec edit / new formula
  removeNode(id)   → CHANGED values only
  getValue(id) / values()
}
```

- **Order-independence (#3):** evaluation is a topological pass (Tarjan SCC, iterative) over the whole
  graph — a definition below its consumer resolves identically (tested both directions).
- **Cycles (#4):** an SCC of size >1 (or a self-loop) poisons its members with the `cycle` error *without
  calling compute*; downstream consumers see the error value and propagate. No hang, no recursion.
- **Incremental:** a mutation recomputes only the mutated/structurally-dirty nodes + transitive dependents,
  and the ripple **stops early** where a value comes out unchanged (tested with compute spies — unrelated
  islands never recompute). Reference **edges are re-resolved on every mutation** (pure id lookups,
  O(total refs) — cheap next to parsing) because a mutation elsewhere can re-aim a reference: a second node
  adopting label J changes what `[J]` includes. Resolver contract: pure, non-throwing (throws are caught →
  error values), and reflecting the current population — the host updates its index *before* mutating.
- The split of `resolve` (edges) from `combine` (fold) is what keeps label semantics out of the engine: a
  grid resolver later returns coordinate/range ids and folds a range into an `array` Value.

## 5. The label resolver — decision #1 (Phase 1 — shipped)

`createLabelResolver(index)` where `index.group(label) → nodeIds` is host-maintained. `resolve` = the
group; `combine` = SUM of the members' number values — one rule: a unique label sums a one-member group
(= itself); `[Label:total]` is normalized by the host to the same token before it gets here. Empty group →
`unresolved`; an error member propagates (its code preserved, so a cycle reads as a cycle downstream);
cross-type members sum as raw scalars (#2).

## 6. Step 2 — how the note host wires it (design, NOT built)

**Environment build (note open):** the existing content-presence scan finds formula nodes → dynamic-import
the engine chunk → for each formula node: extract the optional `Label:` prefix and the `[Ref]` tokens from
its spec → maintain `label → node-ids` (the LabelIndex) → `engine.setNodes` with one EngineNode per formula.
Node ids are ephemeral per-open handles (a NodeView-keyed map; positions re-map via PM). Values land in the
NodeViews from the returned map; nothing persists (#6).

**Reference substitution + eval flow (per node's `compute`):**
1. At node-build time, a shared binder extracts reference tokens: `bindRefs(spec)` finds `\[([^\[\]]+)\]`
   occurrences (reference tokens are single-level by construction — no brackets inside a ref name) and
   replaces each with a sentinel key, yielding a **reference-free skeleton** + the ordered ref names →
   `EngineNode.references`.
2. `compute(refs)` builds a `NumericEnv` over the resolved values (`resolveRef(key)` → the number arm, or
   null on an error arm) and calls the type's `toNumber(skeleton, env)`. Each numeric grammar gains exactly
   one production — *sentinel → env lookup, treated as a raw scalar in the type's canonical unit* (math: a
   number token; imperial: an INCHES value, explicitly not the feet default). Parsers stay per-type (#5).
3. `null` from `toNumber` maps to `eval` (or the first ref error, propagated) → the NodeView's quiet ' = ?'.

**Recompute wiring:** formula-affecting transactions mark the touched node(s); the host coalesces to one
microtask per editor transaction burst, then `upsertNode`/`removeNode`; the returned *changed-only* map
re-renders exactly those NodeViews. A formula whose value didn't change re-renders nothing.

## 7. The nested-bracket detection problem (Step 2 — decided here, for review)

The current insert rule matches `/\[([^[\]]*)\]$/` — the inner `[` of `[12 x [Y] / 2 =]` breaks it.
Compounding it: while typing the outer formula, the inner `]` of `[Y]` fires *first*, and a bare `[Y]` is
itself a legal reference chip — so the inner wrap happens before the outer bracket ever closes, and any
purely-textual outer matcher then faces a doc with a NODE in the middle of its run.

**Chosen approach: wrap-inner-then-ABSORB-on-outer-close.**
- The inner `[Y]` wraps immediately into a reference chip (today's single-level rule, unchanged — live
  feedback of Y's value while typing).
- The outer `]` handler runs a **bounded backward balanced scan over the block's inline content** (not a
  regex): walk text + embedded formula/reference chips (each chip is one opaque token) from the caret to
  the block start, tracking bracket depth; the unmatched `[` is the outer opener. The outer spec is the
  scanned range **serialized back to text** (chips re-emit their `[spec]`/`[Y]` form), the registry
  recognizes it, and the wrap REPLACES the whole range — text and inner chips — with one formula node whose
  spec contains `[Y]` textually (spine-persistable as plain text, #6/zero-migration preserved).
- Bounded: the scan never leaves the current text block and caps at the block's inline length; reference
  tokens are single-level, so real depth is ≤2, but the scanner is general.

**Rejected alternative — defer-while-enclosed** (suppress the inner wrap when an unclosed `[` sits to its
left, then match the outer close with a one-level regex `\[((?:[^[\]]|\[[^\]]*\])*)\]$`): it needs a
"plausibly a formula-in-progress" heuristic to avoid regressing the stray-bracket case (prose like
`I like [ brackets` followed later by `[2+2]` would silently stop wrapping), and it leaves mid-typing dead
states. The absorb approach needs no heuristics and keeps every intermediate state live.

**Open for lead input:** (a) math's label grammar — `[Y: 2+2]` publishes Y; imperial's existing `Trim:`
label doubles as its published label, so label extraction becomes substrate-common in Step 2 (today
imperial's stays internal); (b) whether absorb should also trigger retroactively on EDIT inside an existing
formula (typing `[Y]` into an existing chip's spec is pure text — it needs only ref re-binding, no absorb).

## 8. Performance plan (north-star: load-feel; this lives in every note)

- **Lazy chunk boundary:** everything under `src/formula-engine/` (+ the Step-2 host wiring module) is
  reached ONLY via dynamic `import()` — the `builtins.ts` attachment-runtime pattern. The eager formula
  manifest keeps only what it has today (tiny type registration). Nothing engine-shaped may be
  static-imported from the entry graph; the SW precaches the chunk so warm loads are instant
  (plugins-lazy-past-first-paint).
- **Presence gate:** the ~99% formula-free note does ZERO engine work — no import, no graph, no recompute.
  The gate is the existing on-open content scan (GOTCHA-0022 pattern).
- **Coalesced incremental recompute:** engine is synchronous + pure; the host coalesces per-transaction to
  a microtask, and the engine's changed-only returns + early-stop propagation keep a keystroke's ripple to
  the dirty subgraph (spy-tested).
- **Values never persisted (#6):** the spine stores spec + `ftype`, exactly as today — no new persisted
  shape, no schema/boundary change, no migration, no stale cache class of bugs. (Confirmed during the
  build: nothing in Phase 0/1 crosses a persistence boundary.)
