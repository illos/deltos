import type { Slice, Node as PmNode } from 'prosemirror-model';

/**
 * Clipboard plain-text serializer. PM's default `clipboardTextSerializer` collapses the entire
 * selection to `node.textContent`, losing all structure. When the user copies from deltos and
 * pastes into a terminal, email, or another app, this produces readable markdown-flavoured text.
 *
 * Used as the `clipboardTextSerializer` prop on EditorView — only controls the text/plain
 * flavour of the clipboard; PM's HTML serializer (clipboardSerializer) handles the
 * text/html flavour, which carries the full DOM structure for in-app paste round-trips.
 */

function inlineText(node: PmNode): string {
  // Inline content → markdown-flavoured text/plain (the HTML flavour preserves marks losslessly
  // for in-app paste; this is the readable export when pasting into a terminal/email/another app).
  // Wraps are applied innermost→outermost in a STABLE order — code, bold, italic, strike, highlight,
  // underline — so nested marks produce deterministic output (code first so a code run isn't
  // re-interpreted as emphasis). Link wraps outermost at the mark boundary.
  let out = '';
  node.forEach((child) => {
    if (child.type.name === 'hard_break') { out += '\n'; return; }
    if (child.type.name !== 'text') return;
    let text = child.text ?? '';
    const has = (name: string) => child.marks.some((m) => m.type.name === name);
    if (has('code'))          text = '`' + text + '`';
    if (has('bold'))          text = '**' + text + '**';
    if (has('italic'))        text = '*' + text + '*';
    if (has('strikethrough')) text = '~~' + text + '~~';
    if (has('highlight'))     text = '==' + text + '==';
    if (has('underline'))     text = '<u>' + text + '</u>'; // no MD equivalent — HTML span
    const link = child.marks.find((m) => m.type.name === 'link');
    if (link) text = '[' + text + '](' + (link.attrs.href as string) + ')';
    out += text;
  });
  return out;
}

function nodeToText(node: PmNode, listPrefix = ''): string {
  switch (node.type.name) {
    case 'paragraph':
      return listPrefix + inlineText(node);

    case 'heading': {
      const level = node.attrs.level as number;
      return '#'.repeat(level) + ' ' + inlineText(node);
    }

    case 'blockquote': {
      const inner: string[] = [];
      node.forEach((child) => inner.push(nodeToText(child)));
      return inner.map((l) => '> ' + l).join('\n');
    }

    case 'code_block': {
      const lang = (node.attrs.language as string | null) ?? '';
      return '```' + lang + '\n' + node.textContent + '\n```';
    }

    case 'todo_item': {
      const checked = node.attrs.checked as boolean;
      return listPrefix + (checked ? '[x] ' : '[ ] ') + inlineText(node);
    }

    case 'horizontal_rule':
      return '---';

    case 'bullet_list': {
      const items: string[] = [];
      node.forEach((item) => {
        // list_item contains paragraph (or todo_item) + optional nested lists
        let text = '';
        item.forEach((child) => {
          if (child.type.name === 'paragraph' || child.type.name === 'todo_item') {
            text = nodeToText(child);
          } else {
            // Nested list — indent by 2 spaces
            const nested: string[] = [];
            child.forEach((sub) => nested.push(nodeToText(sub, '  - ')));
            text += '\n' + nested.join('\n');
          }
        });
        items.push('- ' + text);
      });
      return items.join('\n');
    }

    case 'ordered_list': {
      const items: string[] = [];
      let idx = 1;
      node.forEach((item) => {
        let text = '';
        item.forEach((child) => {
          if (child.type.name === 'paragraph' || child.type.name === 'todo_item') {
            text = nodeToText(child);
          } else {
            const nested: string[] = [];
            let subIdx = 1;
            child.forEach((sub) => { nested.push(`  ${subIdx}. ${nodeToText(sub)}`); subIdx++; });
            text += '\n' + nested.join('\n');
          }
        });
        items.push(`${idx}. ${text}`);
        idx++;
      });
      return items.join('\n');
    }

    default:
      return node.textContent;
  }
}

/** Convert a PM Slice to readable plain text for the system clipboard's text/plain flavour. */
export function sliceToPlainText(slice: Slice): string {
  const parts: string[] = [];
  slice.content.forEach((node) => {
    parts.push(nodeToText(node));
  });
  // Collapse 3+ blank lines to double-blank (standard markdown paragraph spacing).
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
