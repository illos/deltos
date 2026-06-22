import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

/**
 * NodeView for todo_item — replaces the CSS ::before checkbox with a real <button> so
 * that clicking/tapping the toggle works on iOS (pseudo-elements aren't reliably tappable).
 *
 * The button carries `data-pm-nosync` so PM's event system ignores it; mousedown prevents
 * default so the click doesn't move the PM cursor into the toggle area.
 */
export class TodoItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private toggleBtn: HTMLButtonElement;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-type', 'todo');
    wrapper.setAttribute('data-checked', node.attrs.checked ? 'true' : 'false');
    if (node.attrs.id) wrapper.setAttribute('data-id', node.attrs.id as string);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'todo__check';
    btn.setAttribute('aria-label', (node.attrs.checked as boolean) ? 'Mark as incomplete' : 'Mark as done');
    // No text glyph — the checkbox is a CSS box (19px, accent-fill + white check when checked);
    // the checked state is driven by the wrapper's data-checked attr (see styles.css §editor).

    // Stop mousedown from moving the PM cursor into the toggle area.
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.getPos();
      if (pos === undefined) return;
      const currentNode = this.view.state.doc.nodeAt(pos);
      if (!currentNode) return;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...currentNode.attrs,
          checked: !(currentNode.attrs.checked as boolean),
        }),
      );
    });

    const content = document.createElement('span');
    content.className = 'todo__content';

    wrapper.appendChild(btn);
    wrapper.appendChild(content);

    this.dom = wrapper;
    this.contentDOM = content;
    this.toggleBtn = btn;
  }

  update(node: PmNode): boolean {
    if (node.type.name !== 'todo_item') return false;
    const checked = node.attrs.checked as boolean;
    this.dom.setAttribute('data-checked', checked ? 'true' : 'false');
    if (node.attrs.id) this.dom.setAttribute('data-id', node.attrs.id as string);
    this.toggleBtn.setAttribute('aria-label', checked ? 'Mark as incomplete' : 'Mark as done');
    return true;
  }
}
