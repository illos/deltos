# Sub-spec — Deploy 3: Editor Formatting Toolbars + Markdown-Light + New Marks (Lanes 3 + 4)

**Status:** IMPLEMENTATION-READY. Turnkey sub-spec — a developer builds directly from this.
**Parent spec:** `docs/specs/ui-visual-refresh.md` (§3 Lanes 3+4, §4-A Deploy 3).
**Design source of truth:**
- `docs/design/ui-refresh/README.md` — §"Active note (editor)" (desktop + mobile), §"Rich text — features, triggers & Markdown export" (the feature→trigger→export→control TABLE = WHAT exists), §"Rich-text element styles".
- `docs/design/ui-refresh/Deltos Rich Text.dc.html` — PRIMARY: live editor, desktop toolbar (button order + dividers, lines 208–230), grouped mobile bar (sub-rows lines 316–349, main row 351–363), `editGroup` state logic (lines 435, 544–546).
- `docs/design/ui-refresh/screenshots/mobile-note-editor-style-group.png` — Style sub-row open, Aa in accent.

**Scope:** This is **Deploy 3** — the largest, riskiest remaining build. It ships ONLY the editor: new
marks (Lane 3 schema), the desktop formatting toolbar, the mobile grouped contextual bar, markdown-light
input rules (Lane 4), keyboard shortcuts, and editor element styles. Tokens (`src/theme/tokens.css`) and
icons (`src/icons/`) already exist (shipped Deploys 1–2). **Tables are OUT of scope** (deferred plugin).

> **⛔ Reviewed on LIVE only.** Per project CLAUDE.md, when this is ready for Jim it deploys to
> `https://deltos.blackgate.studio`. Never hand him a local/preview server. Team automated smoke (headless
> browser, `wrangler dev`) is fine; that is not Jim's review.

> **🚨 Rendered-UI gate (HARD).** Per `[[ui-features-need-rendered-ui-gate]]`: unit-green + tsc-clean ≠
> usable. This feature requires routed-tree render tests asserting real DOM + rules-of-hooks lint + a thin
> on-device smoke of the core flow BEFORE deploy. See §7.

---

## 0. Current state (what exists, what's missing)

Read these before touching anything:

| File | Current state | This deploy |
|---|---|---|
| `packages/client/src/editor/schema.ts` | marks: `bold`, `italic`, `code`, `link`. nodes: title/paragraph/heading/blockquote/code_block/todo_item/bullet_list/ordered_list/list_item/horizontal_rule/plugin_block | **ADD marks** `underline`, `strikethrough`, `highlight` (§1). No node changes. |
| `packages/client/src/editor/ProseMirrorEditor.tsx` | EditorView lifecycle; `canUndo`/`canRedo` state via `undoDepth`/`redoDepth`; toolbar is **Undo/Redo text buttons only** (lines 203–222) | **REPLACE the toolbar** with desktop formatting toolbar + mobile grouped bar; add selection-driven active state plumbing (§2, §3). |
| `packages/client/src/editor/keymap.ts` | `Mod-b/i`, `` Mod-` ``, heading `Mod-Alt-1..6`, `Mod-Alt-0`→p, `Mod-Alt-c`→code block, `Mod-Shift->`→quote, Tab/Shift-Tab list nest | **ADD** `Mod-u` (underline), `Mod-Shift-x` (strike), `Mod-Shift-h` (highlight), `Mod-k` (link) (§5). |
| `packages/client/src/editor/serializer.ts` | `TextSegment` carries `bold/italic/code/link`; spine↔PM round-trip | **EXTEND** `TextSegment` with `underline/strike/highlight`; map both directions (§1). |
| `packages/client/src/editor/clipboard.ts` | plain-text markdown serializer (bold/italic dropped, code backticked) | **ADD** `~~strike~~`, `==highlight==`, `<u>underline</u>`, `**bold**`, `*italic*` to text/plain output (§1). |
| `packages/client/src/editor/plugins/blockId.ts` | re-mints ids on split/paste; `ID_NODE_TYPES` set | **No change** — input rules that change block type go through PM transactions; verify re-mint still fires (§4). |
| `packages/client/src/icons/index.tsx` (branch `ui-refresh`) | 27 icon components — **use these** | New build: see §2 for exact names. |
| `packages/client/src/theme/tokens.css` (branch `ui-refresh`) | 12 color tokens + voice type scale per `[data-palette][data-mode][data-voice]` | Editor element styles read these vars (§6). |

> **Branch note (from parent spec §0):** the Lane 0/1 commits (tokens, icons) were reverted on
> `phase-0-foundation` and live on the `ui-refresh` branch/worktree. Deploy 3 is built on `ui-refresh` (or
> whatever integrates Deploys 1–2), so `src/icons/` and `src/theme/tokens.css` are present there. Confirm
> before starting; do not re-create them.

**NEW files to create:**
- `packages/client/src/editor/commands.ts` — command builders + active-state predicates (§2).
- `packages/client/src/editor/inputRules.ts` — the markdown-light rule set (§4).
- `packages/client/src/editor/EditorToolbar.tsx` — desktop formatting toolbar (§2).
- `packages/client/src/editor/MobileEditorBar.tsx` — grouped contextual bar (§3).
- `packages/client/src/editor/editorState.ts` — selection→active-marks/active-block snapshot type + plugin (§2).
- Render tests alongside each (§7).

---

## 1. Schema additions — new marks

Add three marks to `deltoSchema.marks` in `schema.ts`. **Confirm none already exist:** `bold`, `italic`,
`code`, `link` are present; `underline`, `strikethrough`, `highlight` are **NOT** — these are new. Mark
ORDER in the `marks` object matters for serialization stability; append after `code`, before `link`
(keep `link` with `inclusive:false` last so it doesn't extend on typing).

```ts
// in marks: { ... } — append these three:

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
    // GDocs/Word paste often carries highlight as background — accept yellow-ish bg as highlight:
    { style: 'background-color', getAttrs: (v) => (typeof v === 'string' && v !== '' && v !== 'transparent' ? null : false) },
  ],
  toDOM: () => ['mark', 0] as const,
},
```

Notes:
- Use the mark NAME `strikethrough` (not `strike`) for the schema key — the prototype's `data-cmd="strike"`
  is just a UI id. Command/toolbar code maps `strike`→`marks.strikethrough`.
- `highlight` renders to a bare `<mark>`; the highlight color is supplied by CSS (§6), `color-mix(in srgb,
  var(--accent) 24%, transparent)`. Do NOT bake a color attr into the mark.
- The `background-color` parse rule is defensive for external paste; if it proves too greedy on real paste
  (e.g. catching white-on-white), narrow it or drop it — the `<mark>` tag rule is the primary path.

### Serializer (`serializer.ts`)
Extend `TextSegment` and both conversion directions. Current interface (lines 11–17) → add three flags:

```ts
export interface TextSegment {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  underline?: true;   // NEW
  strike?: true;      // NEW  (maps schema mark 'strikethrough')
  highlight?: true;   // NEW
  link?: string;
}
```

- **`isTextSegment` guard** (lines 38–48): add `if ('underline' in o && o['underline'] !== true) return false;`
  and the same for `strike`, `highlight`. Forward-compatible: unknown future flags are ignored, not rejected.
- **`inlineToSegments`** (PM→spine, lines 114–131): after the existing mark checks add
  `if (child.marks.some(m => m.type.name === 'underline')) seg.underline = true;`
  `if (child.marks.some(m => m.type.name === 'strikethrough')) seg.strike = true;`
  `if (child.marks.some(m => m.type.name === 'highlight')) seg.highlight = true;`
- **`segmentsToPmInline`** (spine→PM, lines 276–287): add to the `marks` array
  `...(seg.underline ? [schema.marks['underline']!.create()] : []),`
  `...(seg.strike ? [schema.marks['strikethrough']!.create()] : []),`
  `...(seg.highlight ? [schema.marks['highlight']!.create()] : []),`

> **Round-trip invariant (test it, §7):** `spineToPmDoc(pmDocToSpine(doc))` is semantically identical for
> a doc containing all six inline marks + a link, including overlapping marks on one run.

### Markdown export mapping (per packet table) — `clipboard.ts`
`clipboard.ts` produces the **text/plain** clipboard flavour (the text/html flavour rides PM's DOM
serializer and round-trips marks losslessly in-app). Currently `inlineText` (lines 13–26) only backticks
`code`. Replace with full inline mark wrapping per the packet's "Exports as" column:

| Mark | Markdown export | Wrap |
|---|---|---|
| bold | `**text**` | `**` … `**` |
| italic | `*text*` | `*` … `*` |
| strikethrough | `~~text~~` | `~~` … `~~` |
| highlight | `==text==` | `==` … `==` (packet allows `<mark>` fallback; use `==`) |
| inline code | `` `code` `` | `` ` `` … `` ` `` (already present) |
| underline | `<u>text</u>` | `<u>` … `</u>` (no MD equivalent — HTML span) |
| link | `[text](url)` | (handle at the link-mark boundary) |

Apply wraps **innermost→outermost** in a stable order (code, then bold, italic, strike, highlight,
underline) so nested marks produce deterministic output; emit code first because a code run shouldn't have
emphasis re-interpreted. Implementation: build the wrap by checking each `child.marks` flag and concentric
string-wrapping. Keep the existing block-level handling (`#`, `>`, fences, `- `, `1. `, `- [ ]`, `---`,
nesting) unchanged. Link export: when a run has a `link` mark, emit `[runtext](href)`.

> Reference: the in-doc demo (`desktopHTML`, lines 506–507) shows bold/italic/underline/strike/highlight/
> code all on one line — use that as the round-trip + clipboard fixture.

---

## 2. Desktop formatting toolbar (`EditorToolbar.tsx`)

**Exact composition** lifted from the prototype desktop toolbar (lines 208–230). One flat **wrapping** row,
`flex-wrap`, gap 3px, padding `8px 18px`, bottom hairline `1px var(--border)`. Four groups separated by a
**1px × 18px `--border` divider** (`<span>` spacer, `margin: 0 4px`). Buttons: transparent bg, radius 6px,
padding `5px 7px`, color `--secondary`, **hover bg `--sel`**, active (see below) bg `--sel` + color `--ink`.

### Button order (left→right), command, icon, active-state
Group 1 — **Block styles** (text-label buttons, not icons):

| Label | data-cmd | PM command | Active when |
|---|---|---|---|
| Title | `h1` | `setBlockType(heading, {level:1})` *(see title caveat)* | cursor in `title` OR an h1 heading |
| Heading | `h2` | `setBlockType(heading, {level:2})` | block is heading level 2 |
| Subhead | `h3` | `setBlockType(heading, {level:3})` | block is heading level 3 |
| Body | `p` | `setBlockType(paragraph)` | block is paragraph |
| Mono | `pre` | `setBlockType(code_block)` | block is code_block |

> **Title caveat:** the doc's title is the **first `title` node** (unified title — schema `doc: 'title block*'`,
> title not in the `block` group, cannot be created in the body). The "Title" button therefore does NOT
> create new title nodes in the body. Behaviour: if the selection is in the body, "Title" maps the block to
> an **h1 heading** (`setBlockType(heading,{level:1})`) — visually "title style" but a body heading. The true
> note title stays the first node. The "Body" button on a heading reverts to paragraph. This preserves the
> `extractTitleFromDoc` contract (`serializer.ts` line 252). Mark this in code with a comment.

Divider. Group 2 — **Inline marks** (B/I/U/S as styled text glyphs, then 3 icons):

| UI | data-cmd | command | Active predicate | Icon component |
|---|---|---|---|---|
| **B** (700) | `bold` | `toggleMark(marks.bold)` | mark active at selection | text "B" (or `Bold` icon) |
| *I* (serif italic) | `italic` | `toggleMark(marks.italic)` | … | text "I" (or `Italic`) |
| U (underline) | `underline` | `toggleMark(marks.underline)` | … | text "U" (or `Underline`) |
| S (line-through) | `strike` | `toggleMark(marks.strikethrough)` | … | text "S" (or `Strike`) |
| highlight | `mark` | `toggleMark(marks.highlight)` | … | `Highlight` |
| inline code `</>` | `code` | `toggleMark(marks.code)` | … | `InlineCode` |
| link | `link` | link command (§ below) | `link` mark in selection | `Link` |

> The prototype renders B/I/U/S as styled `<button>` text (lines 215–218). The `ui-refresh` icon set DOES
> include `Bold`, `Italic`, `Underline`, `Strike` components — either is acceptable; **prefer the styled-text
> glyphs** to match the mock exactly (B bold 700, I serif-italic, U underlined, S struck). Use icon
> components for `Highlight`, `InlineCode`, `Link`, and all of groups 3–4.

Divider. Group 3 — **Lists**:

| UI | data-cmd | command | Active predicate | Icon |
|---|---|---|---|---|
| bullets | `ul` | toggle bullet list (`wrapInList`/`liftListItem`) | inside bullet_list | `BulletList` |
| numbered | `ol` | toggle ordered list | inside ordered_list | `NumberedList` |
| checklist | `check` | toggle todo_item block | block is todo_item | `Checklist` |

Divider. Group 4 — **Blocks/Insert**:

| UI | data-cmd | command | Active predicate | Icon |
|---|---|---|---|---|
| quote | `quote` | `wrapIn(blockquote)` (toggle: lift if already in) | inside blockquote | `Quote` |
| divider | `divider` | insert `horizontal_rule` | — (momentary) | `Divider` |
| image | `image` | open file picker → content-addressed insert *(stub OK)* | — | `Image` |

> **Image scope:** content-addressed image insertion is a larger feature. For Deploy 3 the toolbar button
> may be a **visible no-op / "coming soon" stub** (renders, disabled or toasts) — the packet lists it but
> attachment storage is out of this lane's critical path. Confirm with pilot; do not block the deploy on it.

### Commands module (`commands.ts`)
Centralize so toolbar (desktop + mobile) and keymap share ONE definition. Export:
- `toggleMarkCmd(markName)` → `Command` (thin wrapper over `prosemirror-commands` `toggleMark`).
- `setBlock(nodeName, attrs?)`, `toggleWrap(nodeName)` (quote), `toggleList(listNodeName)`,
  `toggleTodo()`, `insertHorizontalRule()`, `setLink(href)` / `unsetLink()`.
- Lists: use `prosemirror-schema-list` `wrapInList` / `liftListItem`; toggle = if already in that list type,
  lift, else wrap. The schema's `list_item` content is `(paragraph | todo_item) (bullet_list | ordered_list)*`
  — checklist toggle converts the list_item's child paragraph↔todo_item.
- `setLink`: if selection empty, prompt (a minimal inline prompt or `window.prompt` v1) for URL; else wrap
  selection. `unsetLink` removes the mark. (A polished link popover is a future refinement — `window.prompt`
  is acceptable for Deploy 3; note it.)

### Active-state plumbing (`editorState.ts`)
The toolbar's active states are **selection-driven**: they must update on every selection change, not just
doc changes. Current `ProseMirrorEditor.dispatchTransaction` (lines 146–163) only tracks undo/redo depth.

Add a lightweight derivation computed from `view.state` on each transaction (selection changes ARE
transactions in PM):

```ts
export interface EditorActiveState {
  marks: { bold: boolean; italic: boolean; underline: boolean; strike: boolean; highlight: boolean; code: boolean; link: boolean };
  block: 'title' | 'h1' | 'h2' | 'h3' | 'p' | 'pre' | 'quote' | 'todo' | 'ul' | 'ol' | null;
  canUndo: boolean;
  canRedo: boolean;
}
export function deriveActiveState(state: EditorState): EditorActiveState { /* … */ }
```

- **Mark active:** for a non-empty selection, mark is "active" if `state.doc.rangeHasMark(from, to, type)`;
  for an empty selection use `state.storedMarks ?? $from.marks()` and check `type.isInSet(...)`. (Standard PM
  pattern — handles the "toggled-on but not yet typed" stored-mark case.)
- **Block:** inspect `$from` ancestors: title node → `'title'`; heading → `h1/h2/h3` by level; code_block →
  `'pre'`; blockquote ancestor → `'quote'`; todo_item → `'todo'`; bullet_list/ordered_list ancestor →
  `'ul'/'ol'`; else paragraph → `'p'`.
- In `dispatchTransaction`, after `updateState`, compute `deriveActiveState(newState)` and push it to React
  (a `useState` `[active, setActive]` replacing the two `canUndo/canRedo` booleans). This keeps undo/redo and
  all toolbar buttons reactive from one place.

> **Perf:** `deriveActiveState` is O(depth) on every keystroke/selection move — cheap. Do NOT re-derive the
> whole doc. Hold the load-feel value (`[[performance-is-a-standing-value]]`).

### Toolbar dispatch
Buttons fire on `mouseDown` with `preventDefault()` (NOT click) so the editor selection is not lost before
the command runs — the prototype binds `onMouseDown` (line 208). After dispatch, `view.focus()`.

---

## 3. Mobile grouped contextual bar (`MobileEditorBar.tsx`)

The key mobile pattern (prototype lines 314–364, screenshot `mobile-note-editor-style-group.png`). Pinned
to the bottom of the note sub-screen, surface `--nav`, top hairline, **safe-area-aware** bottom padding.

### Structure (two rows)
**Main row** (always visible, prototype lines 351–363): `space-between`.
- LEFT cluster (gap ~26px): four **group toggle** buttons —
  - **Aa** (Style) — styled text, serif-ish, 19px/600
  - **B** (Format) — styled text, 700/19px
  - **☰** (Lists) — `BulletList` icon
  - **+** (Insert) — `Plus` icon
- RIGHT cluster (gap ~20px): a **1px × 22px `--border` divider** then **Undo** (`Undo` icon) + **Redo**
  (`Redo` icon) — **always available** (disabled state reflects `canUndo`/`canRedo`).
- Group icons are `--secondary`; **the active group's icon turns `--accent`** (prototype line 545:
  `editGroup === data-egrp ? var(--accent) : var(--secondary)`).

**Sub-row** (conditional, ABOVE the main row, prototype lines 316–349): surface `--sel`, bottom hairline,
`justify-content: space-around`. Shows the active group's controls. Tapping a group opens its sub-row;
tapping the **same** group again closes it (toggle). Opening a different group swaps the sub-row.

### Per-group control sets (exact, from prototype)
| Group | activeGroup value | Controls (data-cmd) | Source lines |
|---|---|---|---|
| Style | `'style'` | Title `h1` · Heading `h2` · Subhead `h3` · Body `p` · Mono `pre` (text buttons) | 316–324 |
| Format | `'format'` | B `bold` · I `italic` · U `underline` · S `strike` · highlight `mark` · code `code` | 325–334 |
| Lists | `'lists'` | bullets `ul` · numbered `ol` · checklist `check` | 335–341 |
| Insert | `'insert'` | link `link` · quote `quote` · divider `divider` · image `image` | 342–349 |

These map to the **same `commands.ts` builders** as desktop — no duplicate command logic. Sub-row controls
also reflect active state (Format B accented when bold active, Style "Heading" accented in an h2, etc.).

### activeGroup state shape
Per parent spec §State Management:

```ts
type ActiveGroup = 'style' | 'format' | 'lists' | 'insert' | null;
// in MobileEditorBar (local useState — this is ephemeral UI, NOT persisted, NOT in themeStore):
const [activeGroup, setActiveGroup] = useState<ActiveGroup>(null);
const toggleGroup = (g: Exclude<ActiveGroup, null>) =>
  setActiveGroup((cur) => (cur === g ? null : g));
```

- `activeGroup` is component-local React state (ephemeral; resets to `null` on note change / unmount). Do
  not lift to a store unless another surface needs it.
- The parent spec lists `editor activeGroup` under mobile UI state — keep it local to the bar component;
  `phoneView`/`activeNoteId` live in their existing store, `activeGroup` does not need to.

### Safe-area handling
- Bottom padding: `padding-bottom: max(26px, env(safe-area-inset-bottom))` (prototype uses a flat `26px`;
  use `env()` so it adapts to the device — matches the bottom-nav pattern in README §"Mobile — Home").
- The sub-row sits inside the bar's flex column ABOVE the main row, so it does not need its own safe-area
  inset; only the outermost bar container applies the bottom inset.

### Responsive switch (desktop toolbar vs mobile bar)
deltos renders one app responsively (README §Layout: mobile = pushed note sub-screen). The editor must show
the **desktop `EditorToolbar`** on wide layouts and the **`MobileEditorBar`** on the phone/note sub-screen.
Match the existing breakpoint mechanism used by the shell (Lane 2 — `AuthedShell`/`HomeView` device-class
split). Render exactly one; do not mount both. (If the shell exposes a `phoneView`/`isMobile` signal, reuse
it; do not invent a new media-query hook if one exists.)

### iOS caveats
- All sub-row text buttons (Style group) render with the editor voice (`var(--ff)`); their size (13px in
  the mock) is fine — they are `<button>`, not focusable form inputs, so the **≥16px iOS-zoom rule does not
  apply** to them. The **contenteditable body** does (see §6 — Mono voice body must be 16px).
- `mouseDown`/`preventDefault` works for touch via PM, but verify on real iOS that tapping a sub-row button
  does NOT dismiss the soft keyboard / blur the editor (PM keeps selection through `preventDefault`). This is
  a §7 on-device check.

---

## 4. Markdown-light input rules (`inputRules.ts`)

Use `prosemirror-inputrules` (already a transitive dep of the PM stack — confirm in
`packages/client/package.json`; if absent it's tiny and dependency-light, acceptable per load-feel since
it's PM-core-adjacent, but prefer reusing what's installed). Build one `inputRules({ rules: [...] })` plugin
and add it to the plugin list in `ProseMirrorEditor.tsx` (line 112–119) **before** `uniqueBlockIdPlugin` so
id re-minting runs on the resulting transactions.

### The full rule set (from the packet table, README §"Rich text")
**Block rules** (`textblockTypeInputRule` / custom `wrappingInputRule`), trigger at line start:

| Trigger | Rule | Produces |
|---|---|---|
| `# ` | `textblockTypeInputRule(/^#\s$/, heading, {level:1})` * | heading L1 (see title caveat) |
| `## ` | `textblockTypeInputRule(/^##\s$/, heading, {level:2})` | heading L2 |
| `### ` | `textblockTypeInputRule(/^###\s$/, heading, {level:3})` | heading L3 |
| `> ` | `wrappingInputRule(/^>\s$/, blockquote)` | blockquote |
| `` ``` `` | `textblockTypeInputRule(/^```$/, code_block)` | code block (fenced) |
| `--- ` | custom rule on `/^---$/` → replace block with `horizontal_rule` + fresh paragraph after | divider |
| `- ` / `* ` | `wrappingInputRule(/^\s*([-*])\s$/, bullet_list)` | bullet list |
| `1. ` | `wrappingInputRule(/^(\d+)\.\s$/, ordered_list, m => ({order:+m[1]}), …)` | ordered list |
| `[] ` / `[ ] ` | custom rule `/^\[\s?\]\s$/` → set block to `todo_item` (checked:false) | checklist item |

\* **`# ` title caveat:** if the cursor is in the **first body block right after the title** or anywhere in
the body, `# ` makes a body **h1 heading** (not a new title node — title is structurally the first doc node).
The unified-title invariant (`extractTitleFromDoc`) is unaffected. If the cursor is in the title node itself,
`# ` should be inert (the title is already "title style") — guard the rule to skip when `$from.parent.type
=== title`.

**Inline rules** (`InputRule` matching closing delimiter, applying a mark to the captured group):

| Trigger | Regex (match-on-close) | Mark |
|---|---|---|
| `**b**` | `/(?:^|[^*])\*\*([^*]+)\*\*$/` | bold |
| `*i*` | `/(?:^|[^*])\*([^*]+)\*$/` | italic |
| `~~s~~` | `/~~([^~]+)~~$/` | strikethrough |
| `==hl==` | `/==([^=]+)==$/` | highlight |
| `` `code` `` | `` /`([^`]+)`$/ `` | code |

Inline mark rules: on match, replace the matched range with the captured text carrying the mark, and remove
the delimiters. Use a `markInputRule` helper (standard PM recipe — `prosemirror-inputrules` doesn't ship one;
write a ~15-line `markInputRule(regex, markType)` that builds a transaction deleting the delimiters and
adding the mark + clearing stored marks so subsequent typing is unmarked). Order bold (`**`) BEFORE italic
(`*`) so `**` doesn't get eaten by the single-`*` rule.

**Indent/outdent** (NOT input rules — keymap, already present): `Tab` = `sinkListItem`, `Shift-Tab` =
`liftListItem` (keymap.ts lines 107–110). Confirm still wired; no change.

### Interaction with the unique-block-id plugin
- `textblockTypeInputRule` / `wrappingInputRule` change a block's TYPE (paragraph→heading, etc.) via
  `setNodeMarkup` / wrap — the node KEEPS its existing `id` attr. Good: no spurious re-mint, id-first
  invariant holds (`[[swipe-trash-feature-shipped]]` — id stability is foundational).
- The `---` and `[] ` custom rules and list-wrapping CREATE new nodes (divider, list_item wrappers, the
  paragraph after a divider). Those arrive with `id: null` → `uniqueBlockIdPlugin` Step 3 mints fresh ids.
  **This is correct** — but it only fires if the input-rule plugin is ordered BEFORE blockId in the plugin
  array (appendTransaction runs after the input rule's transaction). **Verify in a test** (§7): after
  triggering `---`, both the `horizontal_rule` and the trailing paragraph have non-null unique ids.
- Inline mark rules don't change block structure → no id impact.

### On-device IME caveats (validate, §7) — `[[ui-features-need-rendered-ui-gate]]`
PM input rules fire on `handleTextInput`, which does NOT fire reliably during IME composition on iOS/
Android. The packet itself flags this: README §"Out of scope" — the inline `**bold**`→bold auto-replace was
left out of the prototype's live demo "for reliability"; we implement it via input rules but MUST validate:
- **iOS Safari soft keyboard:** type `# ` at line start, `**bold** `, `- `, `[] `, `> ` — confirm each
  transforms. The space is the trigger; on some IMEs the space arrives as a composition end.
- **Autocorrect/smart-punctuation:** iOS may convert `--` / straight quotes — test `---` divider with
  smart-dash ON and OFF; `==` and `~~` are not auto-converted but verify.
- **Korean/Japanese/Chinese IME:** input rules should NOT fire mid-composition (would corrupt the buffer) —
  PM handles this, but smoke a CJK keyboard typing `# ` to confirm no double-apply.
- If a rule proves flaky on-device, the toolbar/keymap path is the always-works fallback (the packet's
  position) — do not block deploy on a single flaky IME edge; log it.

---

## 5. Keyboard shortcuts (`keymap.ts`)

The mock didn't enumerate shortcuts (README §"Out of scope"); use platform conventions. `Mod` = ⌘ on mac,
Ctrl elsewhere (PM `keymap` resolves `Mod`). ADD to `buildKeymap` (existing bindings stay):

| Shortcut | Command | Status |
|---|---|---|
| `Mod-b` | toggle bold | EXISTS (line 57) |
| `Mod-i` | toggle italic | EXISTS (line 58) |
| `` Mod-` `` | toggle inline code | EXISTS (line 59) |
| `Mod-u` | toggle underline | **ADD** `bindings['Mod-u'] = toggleMark(marks.underline)` |
| `Mod-Shift-x` | toggle strikethrough | **ADD** (GitHub/Notion convention) |
| `Mod-Shift-h` | toggle highlight | **ADD** |
| `Mod-k` | set/edit link | **ADD** → `commands.setLink` (guard: no-op on empty selection or prompt) |
| `Mod-Alt-1..3` | heading L1–3 | EXISTS (loop, line 62–66) — keep 1–6 |
| `Mod-Alt-0` | paragraph (Body) | EXISTS (line 70) |
| `Mod-Alt-c` | code block (Mono) | EXISTS (line 75) |
| `Mod-Shift-.` (`Mod-Shift->`) | blockquote | EXISTS (line 80) |
| `Mod-z` / `Mod-Shift-z` / `Mod-y` | undo/redo | EXISTS (lines 52–54) |
| `Tab` / `Shift-Tab` | list sink/lift | EXISTS (lines 108–109) |

Guard each new binding with `if (marks['underline'])` etc. (the file's defensive pattern, lines 57–59), so a
schema without the mark won't throw. `Mod-u` must be added BEFORE `baseKeymap` merge so it wins over any
browser default (the keymap plugin already spreads base first, line 116 — order is fine).

---

## 6. Element styles (theme-var driven CSS)

Map PM node/mark DOM (from `schema.ts` `toDOM`) to the packet's "Rich-text element styles" (README §; matches
prototype `[data-editor]` rules, lines 19–40). The editor renders into `.editor__pm` (ProseMirrorEditor.tsx
line 223). Scope all rules under the editor root (e.g. `.editor__pm` / the ProseMirror `[contenteditable]`
container). All colors/sizes read theme vars from `tokens.css` — **never hardcode hex**.

> **Where styles live:** if Deploys 1–2 put editor-adjacent CSS in `styles.css`, add these there; otherwise a
> co-located `editor.css` imported by the editor is fine. Match the Lane-2 convention. Remember critical CSS
> is duplicated in `index.html` (parent spec §2 caution) — but editor styles are NOT critical-path (the
> editor mounts after route resolution) so they do NOT need to be in the inline critical CSS.

| Selector | Style (from packet) | Status |
|---|---|---|
| `h1` (title + body h1) | `--ff`, `--h1`, `--h1w`, `--ink`, line-height 1.15, letter-spacing -0.015em | partly — title placeholder exists; add full type |
| `h2` | `--ff`, `--h2`, 600, `--ink` | NEW |
| `h3` | `calc(var(--h2)*0.84)`, 600, `--ink` | NEW |
| `p` | `--ff`, `--note`, line `--line`, `--body` | NEW |
| `ul, ol` | `--ff`, `--note`, `--line`, `--body`, padding-left 24px | NEW |
| `blockquote` | `--ff` italic, `--quote`, `--secondary`, left border `2px var(--accent)`, padding-left 16px | NEW |
| `pre` (code block) | IBM Plex Mono 13px, `--ink`, bg `--sel`, `1px var(--border)`, radius 8px, `white-space:pre-wrap` | NEW |
| inline `code` | IBM Plex Mono 0.88em, bg `--sel`, padding 1px 5px, radius 4px | NEW |
| `a` | `--accent`, underline, `text-underline-offset:2px` | NEW |
| `hr` | border-top `1px var(--border)`, margin 20px 0 | NEW |
| `u` (underline) | `text-decoration: underline` | NEW (mark) |
| `s` (strikethrough) | `text-decoration: line-through` | NEW (mark) |
| `mark` (highlight) | `background: color-mix(in srgb, var(--accent) 24%, transparent)`; color `inherit`; radius 3px; padding 0 2px | NEW (mark) |
| **checklist** (`todo_item`) | flex row gap 11px; checkbox 19px box, 1.6px `--faint` border, radius 6px; checked = `--accent` fill + white check; checked label `line-through` + `--faint` | partial — `TodoItemView` nodeview exists; ensure its DOM matches the `.dt-todo`/`.dt-check` style contract |

> **Checklist:** `todo_item` renders via the existing `TodoItemView` nodeview (ProseMirrorEditor.tsx lines
> 124–127). Style its rendered DOM to the packet's checkbox spec (19px box, accent-fill when checked, white
> check glyph, struck label). The checkbox toggles on tap of the box itself, not the row entering edit
> (README §"Checklist item"). Reuse the `Checkbox`/`Checklist` icon for the check glyph if it fits; the mock
> uses a 3px-stroke white check on accent fill.

> **iOS ≥16px rule (HARD — parent spec §5).** The contenteditable body is a focusable editing surface; iOS
> Safari zooms if computed font-size < 16px. Three of four voices have body ≥16px; **Mono voice `--note` is
> 15px** in the type scale. Parent spec already notes "Mono body already at 16px" was bumped in Lane 0 — VERIFY
> `tokens.css` has `--note: 16px` for `[data-voice="mono"]`; if not, bump it (or set a floor on the editor
> body) so the editor never zooms. Do NOT use `maximum-scale=1`/`user-scalable=no`. Toolbar/sub-row buttons
> are `<button>` (not form fields) → exempt.

---

## 7. Tests + gate

Per `[[ui-features-need-rendered-ui-gate]]` and `[[green-gate-needs-prod-typecheck]]`: green vitest ≠
deploy-clean ≠ usable. ALL of the following before Deploy 3 hits live.

### A. Unit / round-trip (`tdd-cycle`-shaped — pure, assertable)
- **Serializer round-trip:** a fixture doc with all 6 marks + overlapping marks + a link →
  `pmDocToSpine` → `spineToPmDoc` is semantically identical (mark sets per run preserved).
- **`isTextSegment` guard:** accepts `{text, underline:true}`; rejects `{text, underline:'x'}`; ignores
  unknown flags (forward-compat).
- **Clipboard text/plain:** the all-marks line exports `**b** *i* ~~s~~ ==h== <u>u</u> ` `` `c` `` and a
  `[text](url)` link; nested marks deterministic.
- **Input rules (apply against a real EditorState):** each trigger produces the right node/mark —
  `# `→h1, `## `→h2, `### `→h3, `> `→blockquote, `- `→bullet_list, `1. `→ordered_list, `[] `→todo_item,
  ` ``` `→code_block, `---`→horizontal_rule, `**x**`→bold, `*x*`→italic, `~~x~~`→strike, `==x==`→highlight,
  `` `x` ``→code. **One test per row.**
- **blockId interplay:** after `---`, both the `horizontal_rule` and trailing paragraph have non-null,
  distinct ids; after paragraph→heading conversion the id is UNCHANGED.
- **`deriveActiveState`:** cursor in h2 → block `'h2'`; selection over bold text → `marks.bold`; empty
  selection with stored bold mark → `marks.bold`; in a todo_item → block `'todo'`.

### B. Routed-tree render tests (DOM-asserting — the HARD gate)
Mount the editor in its routed context (the note route / `NoteEditor`), assert real DOM:
- **Desktop toolbar renders** all 4 groups in order with the right button count + 3 dividers; buttons have
  accessible labels.
- **Mobile bar:** main row shows Aa/B/☰/+ + Undo/Redo with divider; tapping a group **opens its sub-row
  above** with the correct controls AND the group icon goes `--accent` (assert the active class/color);
  tapping the same group **closes** it; tapping a different group swaps.
- **Each mark toggles:** click B with a selection → selection gains `<strong>`; click again → removed. Same
  for U/S/highlight/code. (Use the test seam `onViewInit` already on `ProseMirrorEditor`, line 25, to drive
  the view.)
- **Block buttons:** click Heading in a paragraph → block becomes h2; Body reverts to p.
- **Active state reflects selection:** put cursor in an h2 → the "Heading" button has the active treatment.
- **rules-of-hooks lint** passes (eslint config fixed @5360d6e per parent spec) — the new components must not
  violate hook rules (the notebooks regression asserted a bug; do not repeat).

### C. Build / load-feel gate
- **`pnpm -C packages/client tsc` (strict, prod)** clean — not just transpile-only vitest
  (`[[green-gate-needs-prod-typecheck]]`).
- **Bundle-delta report** (parent spec §5 hard gate): measure gzip delta of the editor chunk. New deps:
  `prosemirror-inputrules` only (PM-core-adjacent, small). Report the number; the editor is lazy-loaded with
  the note route so it's off the critical path — but still report. No heavy deps.

### D. On-device smoke (the thin core-flow check — `[[ui-features-need-rendered-ui-gate]]`)
On real iOS Safari at the **live** deploy (review-on-live): open a note, (1) type each block trigger
(`# `,`## `,`- `,`[] `,`> `,`---`) and confirm transform; (2) type `**bold** ` inline; (3) open each mobile
group sub-row, toggle a mark, confirm accent + applied; (4) Undo/Redo from the main row; (5) confirm the
editor body does NOT zoom on focus (≥16px); (6) confirm a sub-row tap does not dismiss the keyboard /
selection. CJK + smart-punctuation pass on the input rules per §4 caveats.

### Gate summary
Deploy 3 ships only when: A+B vitest green · rules-of-hooks lint green · strict prod tsc clean · bundle-delta
reported (no heavy deps) · on-device smoke (D) passed on the live deploy. Then Jim reviews on
`https://deltos.blackgate.studio`.

---

## 8. Ambiguities / decisions for pilot
1. **Image button scope** — packet lists it; content-addressed attachment storage is a separate feature.
   Recommend a visible **stub** (or hidden) for Deploy 3, full image insert as a follow-up lane. (§2)
2. **Link UX** — `window.prompt` for v1 (functional) vs an inline link popover (polished). Recommend prompt
   now, popover later; flag if Jim wants the popover in this deploy. (§2, §5)
3. **B/I/U/S as styled text vs icon components** — both exist; spec recommends styled-text glyphs to match
   the mock exactly. Confirm. (§2)
4. **`highlight` background-color parse rule** — defensive for external paste; may be too greedy. Ship with
   it, narrow/drop if real-paste testing shows false positives. (§1)
5. **Desktop toolbar grouping** — packet says grouping desktop like mobile is *optional* (README §"Out of
   scope"); this spec keeps the single flat wrapping row with dividers (matches the mock exactly).
6. **`prosemirror-inputrules` dependency** — confirm it's already in the lockfile (likely transitive); if a
   direct add is needed it's PM-core-adjacent and load-feel-acceptable, but note it on the bundle report.
