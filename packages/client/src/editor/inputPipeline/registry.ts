import type { Command, EditorState, Transaction } from 'prosemirror-state';

/**
 * The unified input-transform registry ([ROAD-0007], docs/design/unified-input-transform-pipeline.md §3.1).
 * Every input-triggered transform (markdown, formula, autolink, …) is defined HERE once and consumed by
 * generic per-surface call sites (native handleTextInput / deckAdapter / the appendTransaction bulk leg) —
 * a feature never touches a keyboard surface again ([[deck-keypad-bypasses-inputrules-keymap]] is the
 * dual-wire disease this kills).
 */

/** The handler contract is prosemirror-inputrules' InputRule handler, verbatim — existing rule bodies port
 *  without rewrites. `start`/`end` span the matched trigger text; the handler consumes it (or returns null). */
export type InsertHandler = (
  state: EditorState,
  match: RegExpExecArray,
  start: number,
  end: number,
) => Transaction | null;

export interface InsertTransform {
  id: string; // 'md-h1', 'formula-auto', 'autolink-space', …
  /** $-anchored regex matched against textblock-start→caret (MAX_MATCH-bounded), like InputRule.match. */
  match: RegExp;
  handler: InsertHandler;
  /** Run inside a code BLOCK? Defaults false; 'only' = run ONLY there (prosemirror-inputrules semantics). */
  inCode?: boolean | 'only';
  /** Run inside a code MARK? Defaults true (prosemirror-inputrules' InputRule default). */
  inCodeMark?: boolean;
  /** Participates in the backspace-revert record (design D3). Defaults true. */
  undoable?: boolean;
}

/** An edit-surface transform: a plain PM command tried in registration order (first-true wins). */
export interface EditTransform {
  id: string;
  cmd: Command;
}

/**
 * A BULK transform (design §4, step 4): runs over a whole just-inserted range (a paste), not a
 * caret-anchored trigger. `from`/`to` bound the inserted content in `state` (the post-insert state);
 * the handler returns a conversion transaction built on `state`, or null to leave the insertion as-is.
 * Only paste-shaped transactions that pass the §2.2 gate ever reach these — first-non-null wins.
 */
export interface BulkTransform {
  id: string; // 'md-paste'
  handler: (state: EditorState, from: number, to: number) => Transaction | null;
}

export type EditSurface = 'backspace' | 'forwardDelete' | 'enterBoundary';

/**
 * Registration order IS execution order — first-match-wins for inserts, first-true-wins for edit chains
 * (§5.4 encodes today's verified plugin order: formula → markdown blocks → marks → autolink). LOAD-BEARING:
 * a registration-order test asserts the compiled order, so reorderings are deliberate, never accidental.
 */
export class TransformRegistry {
  readonly insert: InsertTransform[] = [];
  readonly backspace: EditTransform[] = [];
  readonly forwardDelete: EditTransform[] = [];
  readonly enterBoundary: EditTransform[] = [];
  readonly bulk: BulkTransform[] = [];

  addInsert(t: InsertTransform): void {
    this.insert.push(t);
  }

  addEdit(surface: EditSurface, t: EditTransform): void {
    this[surface].push(t);
  }

  addBulk(t: BulkTransform): void {
    this.bulk.push(t);
  }
}
