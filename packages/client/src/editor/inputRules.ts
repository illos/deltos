import type { Command, Transaction } from 'prosemirror-state';
import type { MarkType } from 'prosemirror-model';
import type { DeltoSchema } from './schema.js';
import { setBlock, toggleList, toggleWrap } from './commands.js';
import type { InsertHandler, TransformRegistry } from './inputPipeline/index.js';

/**
 * Markdown-light transforms (Lane 4), registered into the unified input pipeline ([ROAD-0007] step 1) —
 * defined ONCE here, fired by native typing (the pipeline plugin's handleTextInput) AND the Deck
 * (deckAdapter's generic runner call). CRITICAL consistency invariant (Jim): a markdown trigger and the
 * matching toolbar button MUST produce identical results — so the block handlers dispatch the SAME
 * commands.ts builders the toolbar uses (id-preserving setBlock / toggleList / toggleWrap), then delete
 * the trigger text. Inline handlers apply the same marks (the standard markInputRule recipe: wrap the
 * captured text on the closing delimiter — a different mechanism from toggleMark but the same mark
 * outcome). The pipeline plugin is ordered BEFORE uniqueBlockIdPlugin so new nodes (divider, list
 * wrappers) get fresh ids minted; type-only changes keep their id because setBlock preserves it.
 */

/**
 * Run a shared command for a block trigger, then strip the trigger text. Capturing the command's tr and
 * mapping the trigger range THROUGH that tr means this works for both size-preserving conversions
 * (heading/todo/code) and structure-changing wraps (list/quote). Skips the unified title node.
 */
export function commandRuleHandler(command: Command): InsertHandler {
  return (state, _match, start, end) => {
    if (state.doc.resolve(start).parent.type.name === 'title') return null;
    let captured: Transaction | null = null;
    command(state, (t) => { captured = t; });
    if (captured === null) return null;
    const tr: Transaction = captured;
    tr.delete(tr.mapping.map(start), tr.mapping.map(end));
    return tr;
  };
}

/**
 * Standard markInputRule recipe: on the closing delimiter, replace the matched range with the captured
 * text carrying `markType`, drop the delimiters, and clear the stored mark so subsequent typing is plain.
 */
export function markRuleHandler(markType: MarkType): InsertHandler {
  return (state, match, start, end) => {
    const captured = match[1];
    if (!captured) return null;
    const tr = state.tr;
    const textStart = start + match[0].indexOf(captured);
    const textEnd = textStart + captured.length;
    // Delete trailing delimiter first (higher positions), then the leading one — so neither shifts the
    // other. The captured text then occupies [start, start+len]; mark it and clear the stored mark.
    if (textEnd < end) tr.delete(textEnd, end);
    if (textStart > start) tr.delete(start, textStart);
    tr.addMark(start, start + captured.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  };
}

/** Custom divider handler: replace the current block with a horizontal_rule + a fresh empty paragraph. */
export function dividerRuleHandler(schema: DeltoSchema): InsertHandler {
  return (state, _match, start) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type.name === 'title') return null;
    const hr = schema.nodes['horizontal_rule'];
    const para = schema.nodes['paragraph'];
    if (!hr || !para) return null;
    const blockStart = $start.before();
    const blockEnd = $start.after();
    // hr + paragraph arrive with id:null → uniqueBlockIdPlugin mints fresh distinct ids (plugin order).
    const tr = state.tr.replaceWith(blockStart, blockEnd, [hr.create(), para.create()]);
    return tr.scrollIntoView();
  };
}

/**
 * Register the markdown transforms ([ROAD-0007] step 1: design §1 rows 1–2). Registration order is
 * execution order (§5.4): blocks before inline marks; bold BEFORE italic so `**` isn't eaten by the
 * single-`*` rule (the lookbehind keeps the delimiter out of the match span so no neighbouring character
 * is deleted).
 */
export function registerMarkdownTransforms(registry: TransformRegistry, schema: DeltoSchema): void {
  const { marks } = schema;
  // ── Block triggers (line start) — share the toolbar commands ─────────────────────────────────────
  registry.addInsert({ id: 'md-h1', match: /^#\s$/, handler: commandRuleHandler(setBlock(schema, 'heading', { level: 1 })) });
  registry.addInsert({ id: 'md-h2', match: /^##\s$/, handler: commandRuleHandler(setBlock(schema, 'heading', { level: 2 })) });
  registry.addInsert({ id: 'md-h3', match: /^###\s$/, handler: commandRuleHandler(setBlock(schema, 'heading', { level: 3 })) });
  registry.addInsert({ id: 'md-quote', match: /^>\s$/, handler: commandRuleHandler(toggleWrap(schema, 'blockquote')) });
  registry.addInsert({ id: 'md-codeblock', match: /^```$/, handler: commandRuleHandler(setBlock(schema, 'code_block')) });
  registry.addInsert({ id: 'md-bullet', match: /^\s*[-*]\s$/, handler: commandRuleHandler(toggleList(schema, 'bullet_list')) });
  registry.addInsert({ id: 'md-ordered', match: /^\d+\.\s$/, handler: commandRuleHandler(toggleList(schema, 'ordered_list')) });
  registry.addInsert({ id: 'md-todo', match: /^\[\s?\]\s$/, handler: commandRuleHandler(setBlock(schema, 'todo_item', { checked: false })) });
  registry.addInsert({ id: 'md-divider', match: /^---$/, handler: dividerRuleHandler(schema) });
  // ── Inline marks — closing delimiter fires the wrap ──────────────────────────────────────────────
  if (marks['bold'])          registry.addInsert({ id: 'md-bold', match: /(?<!\*)\*\*([^*]+)\*\*$/, handler: markRuleHandler(marks['bold']) });
  if (marks['italic'])        registry.addInsert({ id: 'md-italic', match: /(?<!\*)\*([^*]+)\*$/, handler: markRuleHandler(marks['italic']) });
  if (marks['strikethrough']) registry.addInsert({ id: 'md-strike', match: /(?<!~)~~([^~]+)~~$/, handler: markRuleHandler(marks['strikethrough']) });
  if (marks['highlight'])     registry.addInsert({ id: 'md-highlight', match: /(?<!=)==([^=]+)==$/, handler: markRuleHandler(marks['highlight']) });
  if (marks['code'])          registry.addInsert({ id: 'md-code', match: /`([^`]+)`$/, handler: markRuleHandler(marks['code']) });
}

