import { inputRules, InputRule } from 'prosemirror-inputrules';
import type { Command, Transaction } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import type { MarkType } from 'prosemirror-model';
import type { DeltoSchema } from './schema.js';
import { setBlock, toggleList, toggleWrap } from './commands.js';
import { BARE_DOMAIN_CORE } from './autolink.js';
import { normalizeLinkInput } from './openLink.js';

/**
 * Markdown-light input rules (Lane 4). CRITICAL consistency invariant (Jim): a markdown trigger and
 * the matching toolbar button MUST produce identical results — so the block rules dispatch the SAME
 * commands.ts builders the toolbar uses (id-preserving setBlock / toggleList / toggleWrap), then delete
 * the trigger text. Inline rules apply the same marks (via the standard markInputRule recipe, which
 * wraps the captured text on the closing delimiter — a different mechanism from toggleMark but the same
 * mark outcome). The plugin is ordered BEFORE uniqueBlockIdPlugin so new nodes (divider, list wrappers)
 * get fresh ids minted; type-only changes keep their id because setBlock preserves it.
 */

/**
 * Run a shared command for a block trigger, then strip the trigger text. Capturing the command's tr and
 * mapping the trigger range THROUGH that tr means this works for both size-preserving conversions
 * (heading/todo/code) and structure-changing wraps (list/quote). Skips the unified title node.
 */
function commandRule(regex: RegExp, command: Command): InputRule {
  return new InputRule(regex, (state, match, start, end) => {
    if (state.doc.resolve(start).parent.type.name === 'title') return null;
    let captured: Transaction | null = null;
    command(state, (t) => { captured = t; });
    if (captured === null) return null;
    const tr: Transaction = captured;
    tr.delete(tr.mapping.map(start), tr.mapping.map(end));
    return tr;
  });
}

/**
 * Standard markInputRule recipe: on the closing delimiter, replace the matched range with the captured
 * text carrying `markType`, drop the delimiters, and clear the stored mark so subsequent typing is plain.
 */
function markInputRule(regex: RegExp, markType: MarkType): InputRule {
  return new InputRule(regex, (state, match, start, end) => {
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
  });
}

/** Custom divider rule: replace the current block with a horizontal_rule + a fresh empty paragraph. */
function dividerRule(schema: DeltoSchema): InputRule {
  return new InputRule(/^---$/, (state, match, start) => {
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
  });
}

export function buildInputRulesPlugin(schema: DeltoSchema): Plugin {
  const { marks } = schema;
  const rules: InputRule[] = [
    // ── Block rules (line start) — share the toolbar commands ───────────────────────────────────
    commandRule(/^#\s$/, setBlock(schema, 'heading', { level: 1 })),   // # → h1 (title node is skipped)
    commandRule(/^##\s$/, setBlock(schema, 'heading', { level: 2 })),  // ## → h2
    commandRule(/^###\s$/, setBlock(schema, 'heading', { level: 3 })), // ### → h3
    commandRule(/^>\s$/, toggleWrap(schema, 'blockquote')),            // > → quote
    commandRule(/^```$/, setBlock(schema, 'code_block')),              // ``` → code block
    commandRule(/^\s*[-*]\s$/, toggleList(schema, 'bullet_list')),     // - or * → bullet list
    commandRule(/^\d+\.\s$/, toggleList(schema, 'ordered_list')),      // 1. → ordered list
    commandRule(/^\[\s?\]\s$/, setBlock(schema, 'todo_item', { checked: false })), // [] / [ ] → checklist
    dividerRule(schema),                                              // --- → divider + paragraph
  ];
  // ── Inline mark rules — bold BEFORE italic so ** isn't eaten by the single-* rule. Lookbehind
  //    keeps the delimiter out of the match span so no neighbouring character is deleted. ──────────
  if (marks['bold'])          rules.push(markInputRule(/(?<!\*)\*\*([^*]+)\*\*$/, marks['bold']));
  if (marks['italic'])        rules.push(markInputRule(/(?<!\*)\*([^*]+)\*$/, marks['italic']));
  if (marks['strikethrough']) rules.push(markInputRule(/(?<!~)~~([^~]+)~~$/, marks['strikethrough']));
  if (marks['highlight'])     rules.push(markInputRule(/(?<!=)==([^=]+)==$/, marks['highlight']));
  if (marks['code'])          rules.push(markInputRule(/`([^`]+)`$/, marks['code']));

  // Autolink (rung-1, #69 E2b): typing a URL then a space links the URL inline (link mark). A bare-URL
  // PASTE alone becomes a rich card instead (embeds plugin); this is the inline/typed path. link is
  // inclusive:false so the mark doesn't extend onto the trailing space or subsequent typing.
  if (marks['link']) {
    const link = marks['link'];
    rules.push(new InputRule(/(https?:\/\/[^\s]+)\s$/, (state, match, start) => {
      const url = match[1];
      if (!url) return null;
      return state.tr.addMark(start, start + url.length, link.create({ href: url, title: null }));
    }));
    // Bare-domain autolink (Jim): 'google.com' / 'www.google.com' + space → link too. GATED on the curated
    // TLD allowlist (BARE_DOMAIN_CORE, src/editor/autolink.ts) so 'etc.'/'file.txt'/'3.14'/'U.S.' don't fire.
    // href via normalizeLinkInput (prepends https://). The ENTER boundary is handled by the autolink keymap.
    rules.push(new InputRule(new RegExp(`${BARE_DOMAIN_CORE}\\s$`, 'i'), (state, match, start) => {
      const url = match[1];
      if (!url) return null;
      const href = normalizeLinkInput(url);
      if (!href) return null;
      return state.tr.addMark(start, start + url.length, link.create({ href, title: null }));
    }));
  }

  return inputRules({ rules });
}
