import { Schema } from 'prosemirror-model';

/**
 * deltos ProseMirror schema. Every node that maps to a spine block carries an `id` attr —
 * the stable UUID that the uniqueBlockId plugin guarantees is unique across copy/paste/split/merge.
 * This is the collab seam and the per-block history anchor.
 *
 * Mapping to spine block types (see serializer.ts):
 *   paragraph    → 'paragraph'
 *   heading      → 'heading'     (level attr: 1–6)
 *   bullet_list  → 'list'        (content.ordered = false; children = list items)
 *   ordered_list → 'list'        (content.ordered = true)
 *   list_item    → internal PM node only; spine represents list items as paragraph children of list
 *   blockquote   → 'quote'
 *   code_block   → 'code'
 *   todo_item    → 'todo'        (checked attr)
 *   hard_break   → line break within inline content
 *   horizontal_rule → 'divider'
 *   plugin_block → open spine type (pluginType attr); the island seam for future plugins
 */
export const deltoSchema = new Schema({
  nodes: {
    // title is always the first (and only) node at the root of the doc; it is NOT in the
    // `block` group so it cannot be created in the body or moved. Enter at end of title
    // creates a new body paragraph (handled by the keymap's title-enter command).
    doc: { content: 'title block*' },

    title: {
      content: 'inline*',
      defining: true,
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'h1[data-type="title"]' }],
      toDOM: (node) =>
        ['h1', { 'data-type': 'title', 'data-id': node.attrs.id as string }, 0] as const,
    },

    // ── Inline leaf ──────────────────────────────────────────────────────────
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'] as const,
    },

    // ── Text blocks ──────────────────────────────────────────────────────────
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'p' }],
      toDOM: (node) => ['p', { 'data-id': node.attrs.id as string }, 0] as const,
    },

    heading: {
      group: 'block',
      content: 'inline*',
      defining: true,
      attrs: { id: { default: null }, level: { default: 1 } },
      parseDOM: [
        { tag: 'h1', attrs: { level: 1 } },
        { tag: 'h2', attrs: { level: 2 } },
        { tag: 'h3', attrs: { level: 3 } },
        { tag: 'h4', attrs: { level: 4 } },
        { tag: 'h5', attrs: { level: 5 } },
        { tag: 'h6', attrs: { level: 6 } },
      ],
      toDOM: (node) =>
        [`h${node.attrs.level as number}`, { 'data-id': node.attrs.id as string }, 0] as const,
    },

    blockquote: {
      group: 'block',
      content: 'block+',
      defining: true,
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: (node) =>
        ['blockquote', { 'data-id': node.attrs.id as string }, 0] as const,
    },

    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { id: { default: null }, language: { default: null } },
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: (node) =>
        [
          'pre',
          { 'data-id': node.attrs.id as string, 'data-language': node.attrs.language as string | null },
          ['code', 0],
        ] as const,
    },

    todo_item: {
      group: 'block',
      content: 'inline*',
      attrs: { id: { default: null }, checked: { default: false } },
      parseDOM: [{ tag: 'div[data-type="todo"]' }],
      toDOM: (node) =>
        [
          'div',
          {
            'data-type': 'todo',
            'data-id': node.attrs.id as string,
            'data-checked': (node.attrs.checked as boolean) ? 'true' : 'false',
          },
          0,
        ] as const,
    },

    horizontal_rule: {
      group: 'block',
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'hr' }],
      toDOM: (node) => ['hr', { 'data-id': node.attrs.id as string }] as const,
    },

    // ── List nodes ───────────────────────────────────────────────────────────
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'ul' }],
      toDOM: (node) => ['ul', { 'data-id': node.attrs.id as string }, 0] as const,
    },

    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'ol' }],
      toDOM: (node) => ['ol', { 'data-id': node.attrs.id as string }, 0] as const,
    },

    list_item: {
      content: '(paragraph | todo_item) (bullet_list | ordered_list)*',
      defining: true,
      attrs: { id: { default: null } },
      parseDOM: [{ tag: 'li' }],
      toDOM: (node) => ['li', { 'data-id': node.attrs.id as string }, 0] as const,
    },

    // ── Plugin island seam ───────────────────────────────────────────────────
    // An opaque atom: the host (this editor) owns cursor/selection around it;
    // the registered plugin owns everything inside via NodeView. No plugin is built here —
    // the seam is shaped now so adding a plugin later requires no schema change.
    // See nodeviews/PluginIsland.ts for the NodeView contract.
    plugin_block: {
      group: 'block',
      atom: true,
      attrs: {
        id: { default: null },
        pluginType: { default: '' },
        pluginContent: { default: null },
      },
      parseDOM: [{ tag: 'div[data-plugin-type]' }],
      toDOM: (node) =>
        [
          'div',
          {
            'data-plugin-type': node.attrs.pluginType as string,
            'data-id': node.attrs.id as string,
          },
        ] as const,
    },
  },

  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b', getAttrs: (n) => (n as HTMLElement).style.fontWeight !== 'normal' && null }],
      toDOM: () => ['strong', 0] as const,
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i', getAttrs: (n) => (n as HTMLElement).style.fontStyle !== 'normal' && null }],
      toDOM: () => ['em', 0] as const,
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0] as const,
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs(dom) {
            const el = dom as HTMLElement;
            return { href: el.getAttribute('href'), title: el.getAttribute('title') };
          },
        },
      ],
      toDOM: (node) =>
        ['a', { href: node.attrs.href as string, title: node.attrs.title as string | null }, 0] as const,
    },
  },
});

export type DeltoSchema = typeof deltoSchema;
