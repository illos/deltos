/**
 * Inline-image resize math (attachment plugin, DEC-0001 salvage path). Factored out as a PURE function so the
 * clamp rules are unit-testable without a jsdom pointer simulation — the NodeView's pointer handlers only do
 * event plumbing + call this.
 *
 * The stored `width` is a REAL display width in CSS px, persisted opaquely in the attachment payload (→ spine,
 * so it syncs for free — no schema/migration). Rendering always sets width only (never height); the CSS keeps
 * `height:auto` so aspect is locked, and `max-width:100%` still caps a wide image at the reading column.
 */

/** Smallest a user can drag an inline image — below this it's an unusable sliver. */
export const MIN_IMAGE_WIDTH = 48;

/**
 * The width an in-progress drag resolves to: the grab-point width plus the pointer's horizontal travel,
 * clamped to [MIN_IMAGE_WIDTH, naturalWidth]. Upscaling past 1:1 (naturalWidth) is disallowed — a stored
 * width larger than the intrinsic pixels is meaningless (the browser would just interpolate/blur). A
 * naturalWidth of 0 (image not yet decoded) means "no known cap" → only the MIN floor applies.
 */
export function computeResizeWidth(startWidth: number, dx: number, naturalWidth: number): number {
  const max = naturalWidth > 0 ? naturalWidth : Number.POSITIVE_INFINITY;
  const capped = Math.min(startWidth + dx, max);
  return Math.max(MIN_IMAGE_WIDTH, Math.round(capped));
}

/**
 * The pluginContent merge the resize commit applies: set `width` to persist a size, or drop it entirely to
 * reset to natural. Pure + immutable (never mutates the input) so the NodeView's transaction path is trivially
 * testable without a live ProseMirror view. Any other payload fields (hash/name/mime/size) pass through.
 */
export function applyWidthToContent<T extends object>(content: T, width: number | undefined): T & { width?: number } {
  const next: T & { width?: number } = { ...content };
  if (width == null) delete next.width;
  else next.width = width;
  return next;
}
