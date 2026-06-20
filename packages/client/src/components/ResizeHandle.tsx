import { MIN_LIST_PANE_WIDTH, MAX_LIST_PANE_WIDTH } from '../db/panePointer.js';
import type { ResizableListPane } from '../lib/useResizableListPane.js';
import './ResizeHandle.css';

interface ResizeHandleProps {
  /** The `handleProps` returned by {@link useResizableListPane}. */
  handle: ResizableListPane['handleProps'];
  className?: string;
}

/**
 * The drag-to-resize divider between the note-list and note panes (desktop 3-region shell, Lane 2
 * Pass B). A focusable vertical separator carrying the `--handle` pill: drag with the pointer or
 * resize with ←/→ (role=separator + aria-value* so it's a real, accessible control). All width state
 * lives in {@link useResizableListPane}; this is the presentational handle.
 */
export function ResizeHandle({ handle, className }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize note list"
      aria-valuemin={MIN_LIST_PANE_WIDTH}
      aria-valuemax={MAX_LIST_PANE_WIDTH}
      aria-valuenow={handle.valueNow}
      tabIndex={0}
      className={`resize-handle${className ? ` ${className}` : ''}`}
      onPointerDown={handle.onPointerDown}
      onKeyDown={handle.onKeyDown}
    >
      <span className="resize-handle__pill" aria-hidden="true" />
    </div>
  );
}
