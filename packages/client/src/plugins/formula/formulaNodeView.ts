import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { FormulaRegistry } from './formulaTypes.js';

/**
 * FormulaNodeView (docs/specs/inline-formulas.md §2) — the type-dispatched NodeView for the inline
 * `formula` node. CONTENT-BEARING: `contentDOM` holds the editable SPEC (so the expression edits inline +
 * live-recomputes), and the per-type OUTPUT renders into a SEPARATE, contentEditable=false element AFTER
 * it. The type OWNS its output DOM (math → '= N'; a future hexcolor → a swatch; a future dice → result +
 * re-roll button), so new output kinds need no NodeView change — the framework just dispatches by `ftype`.
 *
 * Unlike E2b's opaque ATOM card NodeView, this is intentionally NON-atom (the spec is editable PM content);
 * only the output sub-element is held out of PM's content model (ignoreMutation + stopEvent fence it).
 */
class FormulaNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly outputEl: HTMLElement;
  private node: PmNode;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly registry: FormulaRegistry,
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
  }

  /** Recompute + re-render the per-type output from the current spec + state. */
  private renderOutput(): void {
    this.outputEl.replaceChildren();
    const type = this.registry.get(this.node.attrs.ftype as string);
    if (!type) return; // unknown type (e.g. a future type not in this loadout) → spec shows as plain text
    const spec = this.node.textContent;
    const ctx = { state: this.node.attrs.state, setState: (next: unknown) => this.persistState(next) };
    const output = type.evaluate(spec, this.node.attrs.state);
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
    this.renderOutput(); // live recompute on every spec/state change (PM keeps contentDOM in sync itself)
    return true;
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

/** Build the `formula` NodeView factory bound to a registry (the editor registers it under nodeViews.formula). */
export function buildFormulaNodeView(registry: FormulaRegistry) {
  return (node: PmNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new FormulaNodeView(node, view, getPos, registry);
}
