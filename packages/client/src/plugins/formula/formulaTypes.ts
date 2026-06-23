/**
 * Inline-formula FRAMEWORK — the type contract + registry (docs/specs/inline-formulas.md §1). A "formula"
 * is a durable inline construct carrying a TYPE; each type is a plugin declaring how to recognize, evaluate,
 * and render itself. Math is the first (and Phase-1 only) registered type; the contract is DESIGNED so a
 * future interactive/stateful type (dice: on-demand re-roll, persists last roll, loadout-scoped) drops in
 * purely additively — that's the abstraction's honesty check (dice is NOT built).
 *
 * Editor-agnostic at this layer: types deal in strings + DOM output, never ProseMirror. The node + NodeView
 * (formulaNode/formulaNodeView) are the PM glue; the registry is injected so editor core stays plugin-agnostic.
 */

/** The computed output of a formula. `ok` gates valid-vs-error; `display` is the result text for TEXT/NUMBER
 *  outputs (math: the number, or '?' on div0/malformed). VISUAL outputs (a future hexcolor swatch) or
 *  INTERACTIVE ones (a future dice result+button) may ignore `display` and build from the spec/state in
 *  renderOutput. Generalizes across the three output kinds (text/number · visual · interactive). */
export interface FormulaOutput {
  ok: boolean;
  display?: string;
}

/** Context handed to {@link FormulaType.renderOutput} — the persisted type-specific state + a setter so an
 *  INTERACTIVE type (dice re-roll) can persist a fresh result. Static types (math) ignore it. */
export interface FormulaRenderContext {
  /** The node's persisted type-specific state (dice: last roll), or null. */
  state: unknown;
  /** Persist new type-specific state onto the node (interactive types). */
  setState(next: unknown): void;
}

/** A registered formula type. The OUTPUT KIND varies by type (math = static derived value; dice = a
 *  generated-on-demand result + re-roll), but every type implements this one contract. */
export interface FormulaType {
  /** Stable id stored on the node's `ftype` attr (e.g. 'math'). */
  readonly id: string;
  /**
   * AUTO-DETECT trigger: the character that fires it (math: '=') + a detector over the text BEFORE that
   * character. Returns the trailing run that is THIS formula (normalized spec), else null. Optional — a
   * type may be reachable only via the explicit [...] path.
   */
  readonly autoTrigger?: {
    readonly char: string;
    detect(textBeforeCaret: string): string | null;
  };
  /** EXPLICIT [...] path: given the bracketed content, return a normalized spec if it's this type, else null. */
  recognize(content: string): string | null;
  /** Compute the output from the spec (+ persisted state). MUST never throw (errors → { ok:false }). */
  evaluate(spec: string, state: unknown): FormulaOutput;
  /**
   * Build the NON-editable output DOM the NodeView appends after the editable spec. The type OWNS what its
   * output looks like — a '= N' text widget (math), a colored swatch (a future hexcolor), or a result +
   * re-roll button (a future dice) — so new output KINDS slot in without any framework change. Gets the
   * spec (e.g. a swatch needs the color), the computed output, and the render context (state + setState for
   * interactive types).
   */
  renderOutput(spec: string, output: FormulaOutput, ctx: FormulaRenderContext): HTMLElement;
}

/** A resolved match: the type + the normalized spec to store on the node. */
export interface FormulaMatch {
  type: FormulaType;
  spec: string;
}

/**
 * A registry of formula types. Loadout-AWARE by construction: it is an INSTANCE, so a future plugin loadout
 * can build its own registry with a different type set (e.g. a TTRPG loadout that adds dice) — Phase 1 ships
 * one default registry holding only math. The registry never imports PM.
 */
export interface FormulaRegistry {
  register(type: FormulaType): void;
  get(id: string): FormulaType | undefined;
  /** AUTO path: the char just typed + the text before it → the first type whose autoTrigger matches. */
  detectAuto(char: string, textBeforeCaret: string): FormulaMatch | null;
  /** [...] path: the bracket content → the first type that recognizes it. */
  resolveBracket(content: string): FormulaMatch | null;
  /** The distinct auto-trigger characters (to build input rules + the deckAdapter dual-wire). */
  triggerChars(): string[];
}

export function createFormulaRegistry(): FormulaRegistry {
  const types: FormulaType[] = [];
  const byId = new Map<string, FormulaType>();
  return {
    register(type) {
      if (byId.has(type.id)) return; // idempotent
      byId.set(type.id, type);
      types.push(type);
    },
    get(id) {
      return byId.get(id);
    },
    detectAuto(char, textBeforeCaret) {
      for (const type of types) {
        if (type.autoTrigger?.char !== char) continue;
        const spec = type.autoTrigger.detect(textBeforeCaret);
        if (spec) return { type, spec };
      }
      return null;
    },
    resolveBracket(content) {
      for (const type of types) {
        const spec = type.recognize(content);
        if (spec !== null) return { type, spec };
      }
      return null;
    },
    triggerChars() {
      return [...new Set(types.map((t) => t.autoTrigger?.char).filter((c): c is string => !!c))];
    },
  };
}
