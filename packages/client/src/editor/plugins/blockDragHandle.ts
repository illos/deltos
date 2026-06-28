/**
 * Block-object DRAG HANDLE (block-object-chrome) — a minimal grip affordance for the line-owning block
 * objects (link card, attachment). `plugin_block` is `draggable: true` in the schema, so ProseMirror already
 * knows how to drag the whole atom and place it via the drop cursor; the only thing missing was a grab point
 * and an event path to PM.
 *
 * The block NodeViews mount a React interior and use `stopEvent(): true` to keep PM out of that interior. But
 * that also swallows the `dragstart`/`mousedown` PM needs to start a node drag (see eventBelongsToView in
 * prosemirror-view). So: render a small `draggable` grip, and let ONLY the drag-initiating events that
 * originate on the grip pass through to PM. PM's dragstart handler resolves the grip's nearest NodeViewDesc
 * to the draggable atom and drags the whole object — no per-view drag bookkeeping, no new deps.
 *
 * Lives in the LAZY editor chunk (reached only via the editor's plugin NodeViews), never the first-load /
 * list bundle — plain DOM construction; its only import is the co-located stylesheet.
 */
import './blockDragHandle.css';

/** Events that must reach PM from the grip for native node-dragging to work; everything else stays in the view. */
const DRAG_EVENTS = new Set(['mousedown', 'dragstart', 'drag', 'dragend']);

/** Build the grip element. `draggable` so a native dragstart fires; the host NodeView decides where to mount it. */
export function createBlockDragHandle(): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'block-drag-handle';
  handle.setAttribute('contenteditable', 'false');
  handle.setAttribute('aria-label', 'Drag to reorder');
  handle.setAttribute('data-drag-handle', 'true');
  handle.draggable = true;
  // A two-column dot grip (⠿), purely decorative — the CSS owns its look.
  handle.textContent = '⠇';
  return handle;
}

/**
 * The `stopEvent` policy for a block-object NodeView with a drag handle: a drag-initiating event that started
 * on the grip passes through to PM (return false → PM handles it → it drags the atom); EVERYTHING else is the
 * NodeView's (return true → PM ignores it), preserving the React interior's isolation.
 */
export function blockHandleStopEvent(handle: HTMLElement | null, event: Event): boolean {
  if (handle && event.target instanceof Node && handle.contains(event.target) && DRAG_EVENTS.has(event.type)) {
    return false; // let PM own the drag start on the grip
  }
  return true; // the React interior owns all other events
}
