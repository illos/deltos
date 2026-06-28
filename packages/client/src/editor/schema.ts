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

    // Inline-formula node (docs/specs/inline-formulas.md) — the framework substrate. CONTENT-BEARING (not
    // an atom): its inline text content IS the editable SPEC (so the expression edits inline + live-
    // recomputes + backspace-unwraps, exactly as the shipped math chip). `ftype` selects the registered
    // formula type; `state` is a type-specific slot (e.g. a future dice last-roll; null for math). A
    // type-dispatched NodeView (formulaNodeView) renders the per-type OUTPUT after the editable spec. The
    // toDOM/parseDOM here are the serialization/clipboard fallback; the spine round-trip carries it as a
    // formula segment (no migration).
    formula: {
      inline: true,
      group: 'inline',
      content: 'text*',
      marks: '', // the spec is plain text — no marks inside
      attrs: { ftype: { default: 'math' }, state: { default: null } },
      toDOM: (node) =>
        [
          'span',
          {
            'data-formula': 'true',
            'data-formula-type': node.attrs.ftype as string,
            ...(node.attrs.state != null ? { 'data-formula-state': JSON.stringify(node.attrs.state) } : {}),
          },
          0,
        ] as const,
      parseDOM: [
        {
          tag: 'span[data-formula]',
          getAttrs: (dom) => {
            const el = dom as HTMLElement;
            const raw = el.getAttribute('data-formula-state');
            let state: unknown = null;
            if (raw) { try { state = JSON.parse(raw); } catch { state = null; } }
            return { ftype: el.getAttribute('data-formula-type') || 'math', state };
          },
        },
      ],
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
    // SPIKE (block-object-chrome, Mechanic A): re-modelled from a BLOCK atom to an INLINE atom that RENDERS
    // block-level. As an inline atom the caret treats it like a single character — it sits immediately
    // before AND after the object, ArrowLeft/Right step across it one position, Backspace/Delete remove it
    // as ONE unit. It still renders full-width (the NodeView dom is CSS display:block). An inline node must
    // live inside a textblock, so the serializer wraps a top-level plugin block in a paragraph (and unwraps
    // on the way back) — see serializer.ts. `draggable` lets PM drag the whole atom; dropCursor places it.
    plugin_block: {
      inline: true,
      group: 'inline',
      atom: true,
      draggable: true,
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
    // Inline-math expression (docs/specs/inline-math.md) — DISTINCT from `code` so ordinary inline code is
    // never auto-evaluated; only the '=' trigger creates this mark. The marked text IS the expression (the
    // persisted source of truth); the live "= result" is a derived DECORATION (mathPlugin), never stored.
    // inclusive:false → typing past the chip's edge is plain text, not more math.
    math: {
      inclusive: false,
      parseDOM: [{ tag: 'span[data-math]' }],
      toDOM: () => ['span', { 'data-math': 'true', class: 'math-expr' }, 0] as const,
    },
    // Mark order matters for serialization stability — these three append after `code`, before `link`
    // (link stays last with inclusive:false so it doesn't extend on typing). Schema key for strike is
    // `strikethrough`; the UI `data-cmd="strike"` is just an id that command code maps to this mark.
    underline: {
      parseDOM: [
        { tag: 'u' },
        { style: 'text-decoration=underline' },
        { style: 'text-decoration-line=underline' },
      ],
      toDOM: () => ['u', 0] as const,
    },
    strikethrough: {
      parseDOM: [
        { tag: 's' },
        { tag: 'del' },
        { tag: 'strike' },
        { style: 'text-decoration=line-through' },
        { style: 'text-decoration-line=line-through' },
      ],
      toDOM: () => ['s', 0] as const,
    },
    highlight: {
      parseDOM: [
        { tag: 'mark' },
        // Defensive for GDocs/Word paste, which carries highlight as a background colour. The bare
        // <mark> tag rule above is the primary path; narrow/drop this if real paste proves it greedy.
        { style: 'background-color', getAttrs: (v) => (typeof v === 'string' && v !== '' && v !== 'transparent' ? null : false) },
      ],
      toDOM: () => ['mark', 0] as const,
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
      // target/rel: links open in a new tab (deltos is a PWA — never navigate the app away); rel hardens
      // the new context (no window.opener, no referrer). The click-to-open is wired in ProseMirrorEditor.
      toDOM: (node) =>
        ['a', {
          href: node.attrs.href as string,
          title: node.attrs.title as string | null,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, 0] as const,
    },
  },
});

export type DeltoSchema = typeof deltoSchema;
