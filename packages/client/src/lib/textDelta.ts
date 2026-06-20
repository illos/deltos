import type { BlockBody } from '@deltos/shared';
import { noteBodyText } from './search.js';

/**
 * Plain-text projection of a note version (title + body) used by the history-capture layer to measure
 * how much a note changed between checkpoints. Title and body are joined with a newline so a title edit
 * and a body edit are both visible to the delta — and so an empty body still yields the title's text.
 * Reuses {@link noteBodyText} (the search/preview block-text extractor) — no duplicated block walking.
 */
export function noteText(title: string, body: BlockBody): string {
  return `${title}\n${noteBodyText({ body })}`;
}

export interface CharDelta {
  charsAdded: number;
  charsRemoved: number;
}

/**
 * Split (NOT net) character delta between two text snapshots — `charsAdded` + `charsRemoved`, per the
 * spec's "+120 −18" timeline display. Computed by trimming the common prefix and the common suffix, then
 * treating the differing middle as a replace: everything remaining in `prev` was removed, everything
 * remaining in `next` was added. This is the standard diff fast-path — O(n), allocation-free, and EXACT
 * for a single contiguous edit (the overwhelming case: append, fix a word, paste/delete one run). For
 * scattered edits it can over-count the untouched interior, which is acceptable for a coarse change-size
 * indicator and a material-change floor — and it never blows up on a large note the way a full LCS table
 * would (perf is a standing value; capture must not jank). The timeline stores these precomputed, so it
 * never recomputes while scrolling.
 */
export function computeCharDelta(prev: string, next: string): CharDelta {
  if (prev === next) return { charsAdded: 0, charsRemoved: 0 };

  const maxPrefix = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < maxPrefix && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;

  // Common suffix, not overlapping the already-matched prefix in either string.
  let suffix = 0;
  const maxSuffix = Math.min(prev.length, next.length) - prefix;
  while (
    suffix < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    charsRemoved: prev.length - prefix - suffix,
    charsAdded: next.length - prefix - suffix,
  };
}

/** Total magnitude of a change (added + removed) — the value the material-change floor is tested against. */
export function deltaMagnitude(delta: CharDelta): number {
  return delta.charsAdded + delta.charsRemoved;
}
