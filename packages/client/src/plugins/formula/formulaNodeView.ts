import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { FormulaOutput, FormulaRegistry } from './formulaTypes.js';
import { createFormulaBroker, type FormulaBroker, type FormulaHandle } from './formulaHost.js';

/**
 * FormulaNodeView (docs/specs/inline-formulas.md §2) — the type-dispatched NodeView for the inline
 * `formula` node. CONTENT-BEARING: `contentDOM` holds the editable SPEC (so the expression edits inline +
 * live-recomputes), and the per-type OUTPUT renders into a SEPARATE, contentEditable=false element AFTER
 * it. The type OWNS its output DOM (math → '= N'; hexcolor → a swatch; a future dice → result + re-roll
 * button), so new output kinds need no NodeView change — the framework just dispatches by `ftype`.
 *
 * Unlike E2b's opaque ATOM card NodeView, this is intentionally NON-atom (the spec is editable PM content);
 * only the output sub-element is held out of PM's content model (ignoreMutation + stopEvent fence it).
 *
 * STEP 2 (formula-engine.md §6): each NodeView registers an ephemeral HANDLE with the per-editor formula
 * BROKER — construction is the content-presence signal that lazy-loads the reactive environment, and the
 * handle is the node's engine identity (decision #2: per-open, never persisted). The environment pushes
 * host-computed output (cross-formula references, totalizers, the group-typed bare-ref display) through
 * `render`; until/unless it does, the NodeView renders the type's own environment-free `evaluate` — for
 * ref-free formulas the two are identical, so nothing flashes.
 */
class FormulaNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly outputEl: HTMLElement;
  private node: PmNode;
  /** The engine-pushed output (authoritative once present); null = local evaluate only. */
  private hostOutput: FormulaOutput | null = null;
  private readonly handle: FormulaHandle;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly registry: FormulaRegistry,
    private readonly broker: FormulaBroker,
  ) {
    this.node = node;
    this.dom = document.createElement('span');
    this.dom.className = 'formula';
    this.dom.setAttribute('data-formula-type', node.attrs.ftype as string);
    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'formula__spec';
    this.outputEl = document.createElement('span');
    this.outputEl.className = 'formula__output';
    this.outputEl.contentEditable = 'false';
    this.dom.appendChild(this.contentDOM);
    this.dom.appendChild(this.outputEl);
    this.renderOutput();
    // The ephemeral engine handle (Step 2): live spec/ftype reads + the host-output sink.
    this.handle = {
      spec: () => this.node.textContent,
      ftype: () => this.node.attrs.ftype as string,
      render: (output) => {
        this.hostOutput = output;
        this.renderOutput();
      },
    };
    this.broker.register(this.handle);
  }

  /** Recompute + re-render the per-type output — the host-pushed output when the environment has spoken,
   *  else the type's own environment-free evaluate. */
  private renderOutput(): void {
    this.outputEl.replaceChildren();
    const type = this.registry.get(this.node.attrs.ftype as string);
    if (!type) return; // unknown type (e.g. a future type not in this loadout) → spec shows as plain text
    const spec = this.node.textContent;
    const ctx = { state: this.node.attrs.state, setState: (next: unknown) => this.persistState(next) };
    const output = this.hostOutput ?? type.evaluate(spec, this.node.attrs.state);
    this.outputEl.appendChild(type.renderOutput(spec, output, ctx));
  }

  /** Persist type-specific state onto the node (interactive types, e.g. a future dice re-roll). */
  private persistState(next: unknown): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, state: next }));
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.setAttribute('data-formula-type', node.attrs.ftype as string);
    // Live recompute on every spec/state change (PM keeps contentDOM in sync itself). The engine's
    // coalesced flush lands within the same microtask turn, so a stale hostOutput never reaches paint.
    this.renderOutput();
    this.broker.update(this.handle);
    return true;
  }

  destroy(): void {
    this.broker.remove(this.handle);
  }

  /** Hold the OUTPUT element out of PM's content model — its mutations aren't document edits. */
  ignoreMutation(m: ViewMutationRecord): boolean {
    return this.outputEl === m.target || this.outputEl.contains(m.target as Node);
  }

  /** Let interactive output widgets (a future dice button) handle their own events without PM interference. */
  stopEvent(e: Event): boolean {
    return e.target instanceof Node && this.outputEl.contains(e.target);
  }
}

/**
 * Build the `formula` NodeView factory bound to a registry (the editor registers it under
 * nodeViews.formula). `broker` is the per-editor formula broker (ONE per EditorView — the editor creates
 * it alongside the view and disposes it on teardown, so the reactive environment is rebuilt per note
 * open); omitted (tests / minimal mounts), the factory owns a private one.
 */
export function buildFormulaNodeView(registry: FormulaRegistry, broker: FormulaBroker = createFormulaBroker()) {
  return (node: PmNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new FormulaNodeView(node, view, getPos, registry, broker);
}
