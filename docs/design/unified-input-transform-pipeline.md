# Unified input-transform pipeline — design spec

**Status:** DESIGN — awaiting Jim's rulings on the open decisions in §9. No code changed.
**Problem:** every input-triggered transform is wired twice (native `inputRules` + a manual
`deckAdapter` call) with paste as a third path. The dual-wiring already produced two shipped
gaps found during this investigation (§2.3). Goal: a transform is **defined once** and works
across native typing, the Deck, and paste.

Package versions verified against the lockfile: `prosemirror-inputrules@1.5.1`,
`prosemirror-view@1.41.9`, `prosemirror-state`/`prosemirror-history` per pnpm workspace.

---

## 1. Full inventory of input-triggered transforms today

Legend: **INSERT** = fires on a text insertion (fits the pipeline's insert leg).
**EDIT** = acts before/around a delete or on a non-inserting boundary key (needs the shared
command surface). Wiring columns cite the actual call sites.

| # | Transform | Trigger | Native wiring | Deck wiring | Paste wiring | Kind | Special behavior |
|---|-----------|---------|---------------|-------------|--------------|------|------------------|
| 1 | Markdown **block** rules: `# `/`## `/`### `→heading, `> `→quote, ` ``` `→code_block, `- `/`* `→bullet_list, `1. `→ordered_list, `[ ] `/`[] `→todo, `---`→divider | trigger text at textblock start + terminating char | `inputRules.ts:78-86` (`commandRule` 25-35, `dividerRule` 59-72), plugin built at 74-119, registered `ProseMirrorEditor.tsx:596` | **NONE — silently missing** (the known bug) | `markdownToBody` handles the same syntax on paste (`markdownPaste.ts:130`) | INSERT | Dispatches the SAME `commands.ts` builders as the toolbar (id-preserving `setBlock`/`toggleList`/`toggleWrap` — the consistency invariant at `inputRules.ts:11-17`); trigger text deleted through the command's mapping (`inputRules.ts:32`); title node skipped (`:27`); divider mints fresh ids via `uniqueBlockIdPlugin` ordering (`ProseMirrorEditor.tsx:594-596`) |
| 2 | Markdown **inline marks**: `**b**`→bold, `*i*`→italic, `~~s~~`→strike, `==h==`→highlight, `` `c` ``→code | closing delimiter typed | `inputRules.ts:90-94` (`markInputRule` 41-56) | **NONE — silently missing** | inline segments via `parseInline` (`markdown.ts:156`) | INSERT | Deletes delimiters high-to-low so positions don't shift (`:48-51`); `removeStoredMark` so subsequent typing is plain (`:53`); bold ordered before italic + lookbehinds (`:88-90`) |
| 3 | **Autolink on SPACE** (scheme'd URL + curated bare-domain) | URL + space | `inputRules.ts:101-115` (two rules; TLD allowlist `autolink.ts:16-27`) | **NONE for a single space — silently missing** (gap #2, found in this investigation: Deck space goes `Keypad.tsx:117` `actions.insert(' ')` → `deckAdapter.insert:40-47`, which only tries `formulaTriggerOnInsert` — `linkifyTrailingUrl` is only on the double-space path `deckAdapter.ts:83`) | n/a (lone-URL paste → embeds card, `embeds/index.ts:38-53`) | INSERT | `link` mark `inclusive:false`; already-linked guard (`autolink.ts:55`) |
| 4 | **Autolink on ENTER** | trailing URL + Enter | `buildAutolinkKeymap` Enter (`autolink.ts:91-99`), plugin at `ProseMirrorEditor.tsx:592` | `deckAdapter.enter:48-54` (formula-first, else `linkifyTrailingUrl`, then base Enter) | n/a | EDIT (boundary) | No char inserted; normal Enter runs on the post-link state |
| 5 | **Formula auto-trigger** (math `=` consuming; hexcolor space non-consuming) | registry `triggerChars()` | private `inputRules` plugin inside `buildFormulaPlugins` (`formulaPlugin.ts:183-185, 216`), registered `ProseMirrorEditor.tsx:589` | `formulaTriggerOnInsert` called from `deckAdapter.insert:45` — **the same trigger written twice** | none | INSERT | Shared builder `buildAutoFormulaTr` (`formulaPlugin.ts:38-68`) already parameterized for both char-in-doc and char-prospective shapes; `consumesTrigger:false` re-inserts the boundary char (`:66`, hexcolor `hexColorType.ts:39-41`); title guarded (`:47`) |
| 6 | **Formula bracket trigger** `[content]` | closing `]` | bracket `InputRule` (`formulaPlugin.ts:189-200`) | `formulaTriggerOnInsert` `char === ']'` branch (`:109-112`) → `buildBracketFormulaTr` (`:76-90`) | none | INSERT | No-nesting guard (`:85`); no match → literal text stays |
| 7 | **Formula boundary-wrap on ENTER** (bare hex + Enter) | Enter with trailing boundary token | formula keymap Enter (`formulaPlugin.ts:209-214`) | `deckAdapter.enter:52` (`maybeWrapBoundaryFormula`, `formulaPlugin.ts:121-141`) | none | EDIT (boundary) | Shared fn, two call sites — the "thin call site" pattern already exists here |
| 8 | **Formula unwrap on BACKSPACE** (chip right edge → plain spec text) | Backspace at chip edge | formula keymap Backspace (`formulaPlugin.ts:203`) | `deckAdapter.backspace:60` | n/a | EDIT | `unwrapFormulaBackspace` (`formulaPlugin.ts:145-158`) shared command |
| 9 | **Formula unwrap on DELETE** (chip left edge, forward-delete) | Delete before chip | formula keymap Delete (`formulaPlugin.ts:205`) | **not wired** (Deck has no forward-delete key — currently moot, but this is exactly how a gap starts) | n/a | EDIT | `unwrapFormulaDelete` (`:164-178`); caret lands at spec start |
| 10 | **Link unwrap on BACKSPACE** (linked-run right edge → strip mark, consume the press) | Backspace at run edge | autolink keymap Backspace (`autolink.ts:98`) | `deckAdapter.backspace:63` | n/a | EDIT | `unwrapLinkBackspace` (`autolink.ts:70-87`); walks back over contiguous linked text nodes |
| 11 | **Inline-atom single-press delete** (link card / attachment) | Backspace/Delete flanking an inline atom | `keymap.ts:117-118` chains `deleteInlineAtomBackspace/Delete` before base | `deckAdapter.backspace:68` (Backspace only) | n/a | EDIT | `blockAtomChrome.ts` commands, shared |
| 12 | **Markdown paste** (plain text with structure → native blocks) | paste | `handlePaste` in `buildMarkdownPastePlugin` (`markdownPaste.ts:108-139`), registered LAST (`ProseMirrorEditor.tsx:604-608`, ordering rationale `markdownPaste.ts:17-21`) | branch `fix/md-paste-deck-inputmode` @feb480b adds a `beforeinput`/`insertFromPaste` delivery path (iOS edit-menu Paste under `inputmode=none` never fires PM's `handlePaste`) — **superseded by this design's paste leg**, its extraction/dedup logic is reused | itself | INSERT (bulk) | Structure gate `hasMarkdownStructure` (`markdownPaste.ts:57-64`); lone-URL and title guards (`:119-122`); open-depth heuristic (`:87-100`); shared parser `markdownToBody` (`shared/src/spine/markdown.ts:230`) + `spineToPmDoc` |
| 13 | **Sentence-space** (double-space → `. `) | rapid second space | **none** (native iOS keyboard does its own) | `Keypad.tsx:111-120` timing detection → `deckAdapter.sentenceSpace:78-95` | n/a | Deck-local | Timing state (`DOUBLE_SPACE_MS`, `lastSpaceAtRef`) lives in the keypad, not the doc — see §9 D6 |
| 14 | **Auto-capitalize** query | block start / after `. ` | none (native kbd does its own) | `deckAdapter.shouldAutoCapitalize:99-109`, consumed `Keypad.tsx:78-81` | n/a | Deck-local | Pure query, no transform |
| 15 | Bare-URL paste → link card | paste of a lone URL | — | — | `embeds/index.ts:38-53` (handlePaste, contributed plugin, ordered before md-paste) | paste, **stays as-is** | Async unfurl; replaces selection with a `plugin_block` |
| 16 | File/image paste → attachment | paste with files | — | — | `attachmentDrop.ts:114` | paste, **stays as-is** | — |

**Insert-type (pipeline leg):** rows 1, 2, 3, 5, 6, and 12 (bulk).
**Edit-type (shared command surface):** rows 4, 7, 8, 9, 10, 11.
**Deck-local, out of scope (recommended):** rows 13, 14. **Untouched:** 15, 16.

### 1.1 Observed call-site drift (evidence that the disease is structural)

- **Markdown never worked on the Deck** (rows 1–2) — the known bug that motivated this design.
- **Single-space autolink never worked on the Deck** (row 3) — found during this
  investigation; only double-space (`deckAdapter.ts:83`) and Enter linkify there.
- **Deck Enter runs `baseKeymap['Enter']` only** (`deckAdapter.ts:53`), while the native
  keymap's Enter chain is `titleEnter → splitListItem → newlineInCode → createParagraphNear →
  liftEmptyBlock → splitBlock` (`keymap.ts:105-112`). The Deck path is missing `titleEnter`
  and `splitListItem` — Enter inside a list item or the title node behaves differently by
  keyboard. Whether this bites in practice depends on schema fallbacks; it must be verified
  and unified during the edit-surface migration step (§7 step 4, decision D5).
- `unwrapFormulaDelete` is keymap-only (row 9) — harmless today, a landmine when the Deck
  ever grows forward-delete.

Four independent drifts in one codebase pass. The per-feature dual-wire is the bug factory;
the design must make the *feature* register once and make the *surface* wiring generic.

---

## 2. THE GATING PROOF — what may the pipeline ever touch? (safety-critical)

The nightmare scenario: literal `[ ] buy milk` typed on another device syncs in, and the
pipeline "helpfully" converts it — silent note corruption. This section enumerates **every
path by which content enters the live PM document**, with code evidence, then derives the
gating rule.

### 2.1 Every ingress into the editor document

**(a) Note open / note switch — NOT a transaction.**
The doc is built by `spineToPmDoc` and handed to `EditorState.create({ doc, plugins })`
(`ProseMirrorEditor.tsx:578, 616`); the view is created fresh per `noteId`/`customKb`
(effect deps `:739`). `appendTransaction` can never fire here — **initial load is
structurally invisible to the pipeline.** Same for the spellcheck `reconfigure`
(`:783, :789`): `reconfigure` preserves the doc without a transaction.

**(b) Remote sync / MCP-agent writes / history-restore — the `reconcile` transaction.**
There is exactly ONE path by which remote content reaches an *open* editor: server →
`pullUpdates` → `mergePull` → `store.mergeServerNotes` (`syncEngine.ts:427-491`, 2s pull
cadence `:662`) → Dexie → liveQuery props (`NoteEditor.tsx:51-52`) → the #90 reconcile
effect (`ProseMirrorEditor.tsx:747-766`), which dispatches a whole-doc `replaceWith` with
```ts
tr.setMeta('reconcile', true);      // ProseMirrorEditor.tsx:762
tr.setMeta('addToHistory', false);  // ProseMirrorEditor.tsx:763
```
The dispatch handler already branches on this meta to skip the save echo (`:670`). A
history-panel restore is the same ingress: `mutateNotes.put` (`NoteRoute.tsx:88`) → Dexie →
props → reconcile. MCP write-tools mutate D1 server-side and arrive via the same pull.
**Every remote/programmatic-store ingress is one tagged transaction shape.**

**(c) Undo/redo.** `prosemirror-history` transactions carry the history plugin's meta
(key `"history$"`), plus the pipeline must respect `addToHistory:false` generally. Undo of a
conversion must never immediately re-convert (the re-trigger loop); gating on history meta
kills this class.

**(d) Paste/cut/drop (prosemirror-view's own dispatches).** PM tags its default paste
`tr.setMeta("paste", true).setMeta("uiEvent", "paste")` (`prosemirror-view@1.41.9
dist/index.js:3718`), cut `uiEvent:"cut"` (`:3683`), drop `uiEvent:"drop"` (`:3856`). Our own
`handlePaste` plugins (embeds `:38`, attachment `:114`, markdownPaste `:111`) dispatch
**without** any meta today.

**(e) IME/composition.** Composition transactions carry `setMeta("composition", id)`
(`prosemirror-view:5078,5122,5216`); `prosemirror-inputrules` additionally refuses to run
while `view.composing` (dist `run()`: `if (view.composing) return false`). Deltos' primary
mobile path is `inputmode:'none'` (attrs at `ProseMirrorEditor.tsx:629-632`) so no IME there,
but desktop dictation/autocorrect exists.

**(f) Meta-less LOCAL programmatic dispatches — the decisive category.** These are
shape-indistinguishable from typing and carry NO meta today:
- Voice transcript commit: `tr.insertText(transcript)` (`ProseMirrorEditor.tsx:487`)
- Link form submit: `insertText` + `addMark` (`:227-229`)
- Spell correction: `applySpellCorrection` word replace (`spellcheckPlugin.ts`)
- Slash palette: trigger-text delete (`:417`) + `plugin_block` insert (`:426`)
- Embeds card fill: `setNodeMarkup` (`embeds/index.ts:31`); attachment drop inserts
- Deck adapter's own non-insert dispatches (caret moves `deckAdapter.ts:128`, backspace char
  delete `:71`)
- `uniqueBlockIdPlugin`'s appended attr-only transactions (`blockId.ts:71`)
- Spellcheck decoration txns (`spellcheckPlugin.ts:99`, `docChanged:false`)

### 2.2 Opt-out vs opt-in — the ruling and its justification

**Opt-out** ("run on every text-inserting transaction except an exclusion list") *can* be
made safe against (a)–(e): (a) isn't a transaction, (b) has `reconcile`, (c) has `history$` /
`addToHistory:false`, (d) has `uiEvent`, (e) has `composition`. But category **(f) breaks
it**: voice commits, spell corrections, and link inserts are meta-less `ReplaceStep`s with
text, selection-adjacent — exactly the shape of typing. An exclusion list over (f) must be
*complete forever*: every future feature that dispatches an insert becomes a new silent-
corruption vector if its author forgets to add an exclusion. The failure mode of a missed
exclusion is **silent content conversion** — the exact class this design exists to make
impossible.

**Opt-in** ("run ONLY on transactions explicitly tagged as user text input") inverts the
failure mode: a forgotten tag means a transform *doesn't fire* — a visible, benign,
markdown-doesn't-convert bug (the same class as today's forgotten dual-wire, but reduced from
per-feature wiring to one generic per-surface line). Under opt-in, the sync scenario is
structurally inert: a reconcile transaction is untagged, so literal `[ ] ` from another
device can never convert, *even if the reconcile meta were someday renamed or dropped*.

**Recommendation: OPT-IN tagging, with the opt-out exclusions retained as a belt.** The
pipeline runs only on transactions carrying its own meta key, AND additionally hard-skips any
transaction bearing `reconcile`, history meta, `addToHistory:false`, `composition`, or
`uiEvent` ∉ {`paste`} — so even a bug that mis-tags a reconcile is caught. Precedent: the
repo already learned this lesson once — the reconcile path had to invent its meta to stop the
save-echo (`ProseMirrorEditor.tsx:670`); untagged-transaction ambiguity has bitten before.

```ts
// The pipeline's gate, in full:
function isPipelineInput(tr: Transaction): PipelineTag | null {
  const tag = tr.getMeta(inputPipelineKey);          // opt-in: only tagged trs qualify
  if (!tag || tag.kind === 'applied') return null;   // 'applied' = our own output (loop guard)
  // Belt (defense in depth) — none of these should ever be tagged; refuse anyway:
  if (tr.getMeta('reconcile') === true) return null;
  if (tr.getMeta('addToHistory') === false) return null;
  if (tr.getMeta('history$')) return null;           // via the history plugin key
  if (tr.getMeta('composition')) return null;
  const ui = tr.getMeta('uiEvent');
  if (ui && ui !== 'paste') return null;             // cut/drop are never transform inputs
  return tag;
}
```

**Who tags:**
- **Native typing** — delivered through the pipeline's `handleTextInput` (variant-dependent,
  §3.3/§9 D1): either the runner fires there directly (no tag needed — hybrid), or it
  self-dispatches `insertText(...).setMeta(inputPipelineKey, {kind:'typing', text})` (pure).
- **Deck** — `deckAdapter.insert` adds the meta to its existing `insertText` transaction
  (`deckAdapter.ts:46`): one generic line, not per-feature.
- **Paste** — PM's own `uiEvent:'paste'` meta qualifies as an implicit tag for the bulk leg
  (evidence: only prosemirror-view's real paste path sets it), plus an explicit
  `{kind:'paste'}` tag for the Deck's `beforeinput`/`insertFromPaste` delivery adapter.
- **Nothing else tags.** Voice, spell, link-form, palette, embeds, attachment, blockId,
  reconcile all stay untagged and therefore untouched (decision D4 for voice).

### 2.3 Invariant test corpus (ships with the pipeline, step 1)

A dedicated test file feeds the pipeline a corpus of hostile transactions and asserts **zero
appended output**: a reconcile whole-doc replace containing literal `[ ] `, `# `, `**x**`,
`=1+1=`, and a bare URL; an undo/redo of a conversion; a composition-meta insert; an untagged
`insertText('[ ] ')` (the voice shape); a blockId attr-only append; a cut and a drop. Plus
the load-path proof: `EditorState.create` with the same literals → doc unchanged. This corpus
is the regression net for the crux and must never shrink.

---

## 3. Architecture

### 3.1 One registry, one runner

```ts
// editor/inputPipeline/registry.ts
export interface InsertTransform {
  id: string;                     // 'md-heading', 'formula-auto', 'autolink-space', …
  /** Same contract as prosemirror-inputrules' InputRule: $-anchored regex matched against
   *  textblock-start→caret (bounded by MAX_MATCH=500), handler returns a tr or null. */
  match: RegExp;
  handler: (state: EditorState, match: RegExpExecArray, start: number, end: number) => Transaction | null;
  inCode?: boolean | 'only';      // replicate prosemirror-inputrules code-zone semantics
  inCodeMark?: boolean;
  undoable?: boolean;             // participates in the backspace-revert record (D3)
}
export interface EditTransform { id: string; cmd: Command; }

export interface TransformRegistry {
  insert: InsertTransform[];                    // ordered — first-match-wins (§5.4)
  backspace: EditTransform[];                   // formula-unwrap, link-unwrap, atom-delete
  forwardDelete: EditTransform[];               // formula-unwrap-delete, atom-delete
  enterBoundary: EditTransform[];               // formula-wrap, linkify (order: formula first)
}
```

Features contribute at editor assembly (the A1 manifest spine's
`collectEagerContributions` is the natural aggregation point — it already carries
`formulaRegistry` and `buildEditorPlugins`, `ProseMirrorEditor.tsx:188-189`): core markdown
registers its rules, the formula plugin registers auto/bracket/boundary/unwraps, autolink
registers space/enter/backspace. **Registered once. No feature ever touches a keyboard
surface again.**

### 3.2 The runner — replicating `handleTextInput` semantics at either level

The reference semantics (from `prosemirror-inputrules@1.5.1` `run()`, read in full):

1. Never while `view.composing`.
2. `textBefore = $from.parent.textBetween(max(0, parentOffset − 500), parentOffset, null, "￼") + text`
   — textblock-scoped, leaf nodes as object-replacement chars, `MAX_MATCH = 500`.
3. Per rule, in order: skip if a code mark is at the caret and `!inCodeMark`; skip if the
   parent is a code block and `!inCode` (or if `inCode === 'only'` and it isn't);
   `match = rule.match.exec(textBefore)`; require `match[0].length >= text.length`;
   `startPos = from − (match[0].length − text.length)`; re-check no code mark inside
   `[startPos, from]`; call `handler(state, match, startPos, to)`; first non-null tr wins.
4. If `undoable`, record `{transform, from, to, text}` for the revert command.

**Pre-insert shape** (native `handleTextInput`): the trigger char is prospective —
`textBefore` gets `+ text`, `to` = the caret, and the handler consumes the char by never
inserting it. This is bit-identical to today.

**Post-insert shape** (transaction level, for tagged Deck/paste transactions in
`appendTransaction(trs, oldState, newState)`): the char IS in the doc. The runner anchors at
`newState.selection.$head` (requiring: tagged tr, `selection.empty`, head at the inserted
text's end — all true for Deck single-char inserts by construction), computes
`textBefore = block-start → caret` (no `+ text`), and calls
`handler(newState, match, startPos, caret)`. The matched span `[startPos, caret]` now
*includes* the trigger char, and every existing handler already consumes whatever
`[start, end]` spans:
- `commandRule` deletes `[start, end]` through the command's mapping (`inputRules.ts:32`) —
  deletes `"# "` including the space. ✓
- `markInputRule` computes inner offsets from the match (`:46-52`). ✓
- `dividerRule` replaces the whole block (`:69`). ✓
- Formula auto: adapter passes `(char, boundary = caret − text.length, deleteEnd = caret)` —
  `buildAutoFormulaTr` is *already* parameterized for exactly these two shapes
  (`formulaPlugin.ts:36-44` doc comment). ✓
- Formula bracket: `replaceWith(start, end)` consumes the `]` wherever it lives (`:199`, and
  the keypad path `:76-90` already proves the post-insert shape works). ✓

So the SAME rule definitions serve both shapes; only the thin runner adapters differ. The
appended transaction returned from `appendTransaction` is built on `newState` — no rebasing.

### 3.3 The two delivery variants (Jim rules — §9 D1)

**Variant P — "pure": everything through `appendTransaction`.**
The pipeline plugin's `handleTextInput(view, from, to, text)` returns `false` while
`view.composing`, else **self-dispatches** `view.state.tr.insertText(text, from, to)
.setMeta(inputPipelineKey, {kind:'typing', text})` and returns `true`. Now native, Deck, and
paste are all tagged transactions, and `appendTransaction` is the single downstream point
running the post-insert runner.
*Cost:* we take over PM's native insertion (mark inheritance, `insertReplacementText`
autocorrect interplay, DOM-change reading are subtle in prosemirror-view); the trigger char
lands and is then transformed in the same state update (no paint between — appended trs are
applied before the view re-renders — so no flicker, but undo grouping changes, §5.1).

**Variant H — "hybrid": one runner, generic call sites; `appendTransaction` for bulk only.**
- Native: pipeline `handleTextInput` runs the **pre-insert** runner directly (exact
  `prosemirror-inputrules` semantics, today's behavior bit-for-bit) and returns true only
  when a rule fired.
- Deck: `deckAdapter.insert` becomes
  `if (runPreInsert(v.state, v.dispatch, pos, pos, text)) return;` then plain insert —
  replacing the formula-only call at `deckAdapter.ts:45` with the full shared table. One
  generic line; markdown + linkify + formula all arrive on the Deck at once.
- Paste/bulk: the `appendTransaction` leg, gated per §2.2, handles tagged paste insertions.

**Recommendation: Variant H.** Reasoning: (i) §2 forces opt-in tagging either way, which
nullifies P's only structural advantage ("new sources automatically covered" — under opt-in
they must tag, which is the same one line as calling the runner); (ii) P rewires the native
typing path for zero coverage gain and real composition/autocorrect risk; (iii) H preserves
the tested `handleTextInput` semantics exactly (the 19 assertions in
`editorInputRules.test.ts` drive `inputPlugin.props.handleTextInput` directly and port
verbatim); (iv) both variants kill per-feature dual-wiring equally — the irreducible residue
in H is one generic runner invocation per input surface, which is the same residue as P's
per-surface tag. The per-FEATURE wire — the actual bug factory (§1.1) — dies in both.
The `appendTransaction` machinery, gating, and invariant corpus are built regardless (the
paste leg needs them), so H is not a retreat from the chosen direction — it narrows the
transaction-level surface to the one source (paste) where PM itself owns the dispatch.

### 3.4 The edit-transform surface (backspace / delete / enter)

Already half-built as shared commands with two call sites (rows 4, 7–11). The design
completes it: the registry's `backspace`/`forwardDelete`/`enterBoundary` arrays are compiled
into ONE chained command each:

```ts
export const pipelineBackspace: Command = chainCommands(...registry.backspace.map(t => t.cmd));
export function pipelineEnterBoundary(state, dispatch): boolean { /* first-true of enterBoundary */ }
```

- **Keymap side:** `keymap.ts` binds `Backspace: chainCommands(pipelineBackspace,
  baseKeymap['Backspace'])`, `Delete` likewise, and the Enter chain runs
  `pipelineEnterBoundary` before the (unchanged) `titleEnter → splitListItem → …` chain
  (`keymap.ts:105-118`). The formula plugin's private keymap (`formulaPlugin.ts:202-215`)
  and `buildAutolinkKeymap` (`autolink.ts:91-99`) are **deleted**.
- **Deck side:** `deckAdapter.backspace` becomes `if (pipelineBackspace(...)) return;` +
  its existing char-delete fallback (`deckAdapter.ts:69-72`); `deckAdapter.enter` becomes
  `pipelineEnterBoundary(...)` then the normal Enter; a space keystroke runs the insert
  runner (which now carries the space-linkify rule — closing gap #2).
- **Ordering encoded once:** backspace = [formula-unwrap, link-unwrap, atom-delete] (today's
  verified parity order: native `ProseMirrorEditor.tsx:589 → 592 → 593` plugin order; Deck
  `deckAdapter.ts:60 → 63 → 68`). Enter boundary = [formula-wrap, linkify] (native `589→592`,
  Deck `:52`). Registration order IS the chain order; a comment marks it load-bearing.

Adding a future edge-of-thing backspace behavior = one registry entry; both keyboards get it.

---

## 4. Incremental (typing) vs bulk (paste)

**Typing: surgical, per-rule, cursor-anchored — NOT whole-block reparse.** Justification:
- *Feel:* per-keystroke cost is one bounded regex pass over ≤500 chars of the current
  textblock (identical to today's two `inputRules` plugins, now consolidated to one pass) —
  no parser allocation, no doc rebuild. Performance is a standing value.
- *Over-conversion is the risk that matters:* a whole-block reparse (`markdownToBody` on the
  current block per keystroke) would convert text the user deliberately left literal (typed
  `**x**` earlier, escaped past the rule by editing, then typing anywhere in the block
  re-converts it), and cannot preserve non-markdown inline content (formula chips, atoms —
  `markdownToBody` has no representation for them; a reparse would destroy them).
  Surgical rules only ever touch `[startPos, caret]` of the text just typed. The trigger is
  the *keystroke*, not the *content* — which is exactly the property that makes remote
  literals safe even before gating.
- *Cursor:* each handler already owns its caret/stored-mark behavior (§1 table); no
  generic cursor logic needed for typing.

**Paste: bulk, range-scoped, structure-gated.** The bulk leg (the `appendTransaction` leg in
both variants) reuses the shipped conversion core:
1. Delivery adapters produce ONE tagged plain-text insertion: PM's default paste
   (`uiEvent:'paste'`) or the Deck `beforeinput`/`insertFromPaste` adapter from @feb480b
   (kept, but reduced to: extract text, insert it tagged `{kind:'paste'}` — its conversion
   logic and its `RECENT_PASTE_WINDOW_MS` dedup move into/are replaced by the pipeline).
2. The runner computes the inserted range from the transaction's step map
   (`tr.mapping.maps`-derived changed ranges — the only ranges ever touched), extracts its
   text with `\n` block separators, and applies the existing gate chain verbatim:
   files → skip; lone bare URL → skip (embeds owns it); in-title → skip;
   `hasMarkdownStructure(markdownToBody(text))` false → skip (`markdownPaste.ts:31-64`
   guards, unchanged).
3. On pass: `replaceRange` the inserted range with `markdownTextToSlice`'s output
   (`markdownPaste.ts:87-100` — open-depth heuristic preserved), caret to range end.
4. **Rich-paste guard:** additionally skip when the inserted slice already contains any
   non-paragraph node or any marked text — a rich HTML paste arrived structured via
   `parseDOM`/`transformPastedHTML` and must not be re-parsed. (This is the post-insert dual
   of the current "text/plain only" framing and keeps the `transformPastedHTML` path intact.)
5. `handlePaste` handlers that fully own their paste (embeds card, attachment) still return
   true and dispatch untagged — the pipeline never sees them. Ordering constraints at
   `ProseMirrorEditor.tsx:604-608` become irrelevant for markdown (it no longer competes in
   `handlePaste` at all) — one whole class of ordering bugs deleted.

Alternative (D2, non-recommended): keep `handlePaste` conversion as a third thin call site of
the shared core (`tryConvertMarkdownText` from @feb480b). Fewer moving parts, but keeps two
paste delivery paths permanently and leaves the `someProp` ordering constraint alive.

---

## 5. Semantics that must be nailed

### 5.1 Undo
- **Today:** `undoInputRule` is NOT bound anywhere (verified: zero references in
  `src/`/`test/`) — backspace after `- ` → list just deletes into the list; Mod-z reverts the
  conversion (history event includes the rule's tr; with `newGroupDelay: 500ms`
  (`ProseMirrorEditor.tsx:74, 597`) the trigger keystrokes usually group with it, so one
  Mod-z lands before the trigger text — current, accepted behavior).
- **Variant H typing:** bit-identical to today (same pre-insert tr shape).
- **Variant P / the paste-bulk leg:** trigger insert + appended transform are separate
  transactions in the same dispatch cycle → same history group (500ms) → one Mod-z reverts
  both. Parity in practice; document as acceptable drift if P is chosen.
- **Backspace-reverts-autoformat (D3, recommended ADD):** the pipeline records its last
  applied transform `{invertedSteps, trigger}` in plugin state (cleared on any selection move
  or doc change that isn't its own — exactly `prosemirror-inputrules`' plugin-state recipe,
  dist `apply()`), and exposes `undoLastTransform: Command` registered FIRST in the
  `backspace` edit-chain. Because the chain is consumed by both keyboards (§3.4), the revert
  works on the Deck too — something `undoInputRule` alone could never do. Restores the
  trigger text (e.g. list → `- ` literal), one extra backspace then deletes normally.

### 5.2 Loop prevention
Three independent guards: (1) opt-in — the appended tr is tagged `{kind:'applied'}`, which
`isPipelineInput` rejects; (2) PM's `appendTransaction` round-trips the appended tr through
all plugins (that's how `uniqueBlockIdPlugin` mints ids for rule-created nodes — ordering:
pipeline plugin registered BEFORE `uniqueBlockIdPlugin`, preserving today's
input-rules-before-blockId invariant, `ProseMirrorEditor.tsx:594-596`), and our own plugin
sees it but guard (1) stops recursion; (3) handlers produce output that no rule matches
(a heading block no longer contains `# `), so even a hypothetical double-run converges. The
paste-bulk output likewise fails `hasMarkdownStructure`-on-plain-paragraphs re-entry because
its output *is* structured (guard §4.4 direction: structured input is skipped).

### 5.3 No-convert zones
- **Code:** replicate `inCode`/`inCodeMark` from the reference runner (§3.2 step 3) — both
  the caret's stored/context marks and a scan of `[startPos, caret]`. Today's core rules get
  `inCodeMark: false`-equivalent defaults matching `prosemirror-inputrules` (rules don't run
  in code marks/blocks unless opted in). Paste-bulk: skip when the insertion point's parent
  is a code block (pasting markdown INTO a code block stays literal).
- **Title:** per-rule guards preserved (`inputRules.ts:27, 62`; `formulaPlugin.ts:47, 79,
  129`; `autolink.ts:47`; paste `markdownPaste.ts:67-72`) — hoisted into ONE runner-level
  guard (caret in `title` → no insert transforms at all), deleting six scattered checks.
- **Scope:** the incremental runner only ever matches textblock-start→caret of the block
  being typed in (MAX_MATCH-bounded); the bulk runner only touches the inserted range's
  changed-range envelope. Surrounding existing text is unreachable by construction.

### 5.4 Ordering among transforms
First-match-wins over ONE ordered list, preserving today's effective order (native plugin
order `ProseMirrorEditor.tsx:588-596` and array order `inputRules.ts:76-116`):
```
1. formula-auto (per trigger char)   — was plugin @589, before core rules
2. formula-bracket (])
3. markdown blocks (# ## ### > ``` - * 1. [ ] ---)
4. markdown inline marks (** * ~~ == `)   — bold before italic (inputRules.ts:88-90)
5. autolink space (scheme'd, then bare-domain)
```
Non-overlap notes: formula `=`/`]` triggers don't collide with markdown patterns; `[ ] `
(todo, space-terminated at line start) vs `[...]` (bracket formula, fires on `]`) resolve on
different trigger chars — but the bracket rule matching `[ ]` content is checked against the
registry (`resolveBracket(' ')` → no formula type matches → null → falls through; verified
shape at `formulaPlugin.ts:87`). Enter-boundary order: formula before linkify ("a trailing
token is either a formula or a URL, not both" — `deckAdapter.ts:50-52`). A registration-order
test asserts the compiled list matches this table so a refactor can't silently reorder.

### 5.5 Cursor placement
Unchanged per-handler (each already dispatches its final selection/stored-mark state — §1).
The runner adds none. Bulk paste: caret at the end of the replaced range
(`replaceSelection`/`replaceRange` default, as today `markdownPaste.ts:134`).

---

## 6. Registration API sketch (end-state)

```ts
// A feature registers ONCE, at manifest/assembly time:
registry.addInsert({
  id: 'md-todo',
  match: /^\[\s?\]\s$/,
  handler: commandRuleHandler(setBlock(schema, 'todo_item', { checked: false })),
});
registry.addInsert({ id: 'formula-auto-=', match: /=$/,
  handler: (state, _m, start, end) => buildAutoFormulaTr(state, freg, '=', start, end) });
registry.addEdit('backspace', { id: 'formula-unwrap', cmd: unwrapFormulaBackspace });
registry.addEdit('enterBoundary', { id: 'linkify', cmd: linkifyTrailingUrl });

// The surfaces consume generically (written once, never touched by features):
//   native:  pipelinePlugin({ registry })       // handleTextInput → runPreInsert (H)
//            + keymap chains from registry (§3.4)
//   deck:    deckAdapter calls runPreInsert / pipelineBackspace / pipelineEnterBoundary
//   paste:   appendTransaction leg, gate per §2.2, bulk per §4
```

`InsertTransform` is deliberately the `InputRule {match, handler}` contract so today's rule
bodies move without rewrites; `commandRule`/`markInputRule`/`dividerRule` become exported
handler factories.

---

## 7. Migration plan — big-bang end-state, internally sequenced

Each step lands green, deletes exactly one dual-wire, and leaves unmigrated features on their
old wiring. No flag day; the live site is deployable after every step.

**Step 0 — pipeline core + gating proof.** Registry, runner (both shapes), pipeline plugin,
edit-chain compiler, and the §2.3 invariant corpus. Nothing registered yet; zero behavior
change. *Net:* the new corpus; full suite stays green untouched.

**Step 1 — markdown (the proving ground).** Move rows 1–2 (+ the space-autolink rule, row 3,
if D-order prefers it here) from `buildInputRulesPlugin` into the registry;
`deckAdapter.insert` gains the generic runner call. `inputRules.ts` shrinks to handler
factories; the `inputRules({rules})` plugin instance for these rules is deleted.
**This step ships the original bug fix: markdown works on the Deck.**
*Net:* `editorInputRules.test.ts` (19 — the `fire()` harness drives `handleTextInput`
directly and ports to the pipeline plugin's prop verbatim), new Deck-markdown tests mirroring
each assertion through `deckAdapter.insert`, blockId-interplay assertions (id-preserved on
type change, fresh ids on divider — `editorInputRules.test.ts` "blockId interplay" block).
*Preserve exactly:* toolbar≡trigger command identity (`inputRules.ts:11-17`), title inertness,
`--- ` id minting.

**Step 2 — formula.** Register auto + bracket insert rules; delete `buildFormulaPlugins`'
private `inputRules` plugin (`formulaPlugin.ts:216`) and the `formulaTriggerOnInsert` call in
`deckAdapter.insert:45` (the function itself may be deleted once both callers are gone —
its builders `buildAutoFormulaTr`/`buildBracketFormulaTr` survive as the handlers).
*Net:* `formulaPlugin.render.test.tsx` (26), `formulaRegistry.test.ts`,
`hexColorType.render.test.ts` (the `consumesTrigger:false` space-preserving path),
`deckAdapter.test.ts` (10). *Preserve:* hexcolor's non-consuming space re-insert
(`formulaPlugin.ts:66`), title guard, no-nesting bracket guard.

**Step 3 — autolink + Enter boundary + unwraps → edit surface.** Register
space-linkify (insert), enter-boundary [formula-wrap, linkify], backspace [formula-unwrap,
link-unwrap, atom-delete], forward-delete [formula-unwrap-delete, atom-delete]. Delete: the
formula keymap plugin (`formulaPlugin.ts:202-215`), `buildAutolinkKeymap` (`autolink.ts:
91-99` + registration `ProseMirrorEditor.tsx:592`), the manual chain in
`deckAdapter.backspace:60-68` and `deckAdapter.enter:52`, and the space-rule pair in
`inputRules.ts:99-116`. **Fixes the Deck single-space linkify gap.** Resolve D5 (Deck Enter
chain parity) here.
*Net:* `autolink.render.test.tsx` (16), `formulaUnwrap.test.ts` (5),
`deckBlockObjectDelete.test.ts`, `blockObjectChrome` tests, `editorKeymap.test.ts`; new
same-order parity test asserting keymap chain ≡ deck chain ≡ registry order.
*Preserve:* backspace-unwrap consumes the press (second press deletes), formula-before-
linkify exclusivity, `inclusive:false` link mark behavior.

**Step 4 — paste (supersedes branch `fix/md-paste-deck-inputmode`).** Implement the bulk leg
per §4 and D2's ruling; `markdownPaste.ts` keeps `markdownTextToSlice` +
`hasMarkdownStructure` (they ARE the bulk core) and loses its `handlePaste` interception;
the @feb480b `beforeinput` adapter is rebased to extraction-only. Embeds/attachment
`handlePaste` untouched.
*Net:* `markdownPaste.test.ts` (16), `markdownPaste.inAppCopy.test.ts` (2),
`markdownPaste.render.test.ts` (9), the branch's `markdownPaste.deck.test.ts`; new
rich-paste-skip and paste-into-code-block-skip tests. *Preserve:* structure gate semantics
(prose and rich-HTML pastes untouched), lone-URL deference to embeds, title-paste-plain,
open-depth merge heuristic.

**Step 5 — sweep.** Delete dead exports, update `[[deck-keypad-bypasses-inputrules-keymap]]`
memory (the gotcha becomes "register in the pipeline"), on-device Deck smoke (markdown,
formula, links, paste — per the `ui-features-need-rendered-ui-gate` rule) before deploy.

---

## 8. Risks & note-integrity safeguards

| Risk | Severity | Safeguard |
|------|----------|-----------|
| Pipeline converts synced/loaded literal text | CRITICAL | Opt-in gating (§2.2) + belt exclusions + §2.3 invariant corpus (permanent); load path structurally exempt (`EditorState.create`) |
| A missed tag/call-site = transform silently absent on one surface | LOW (benign direction) | The failure mode is visible non-conversion, not corruption; per-surface wiring is one generic line, covered by the mirrored Deck test suite (step 1) |
| Undo/history drift (bulk leg & Variant P: trigger + transform as two trs) | MED | Same-dispatch-cycle grouping under `newGroupDelay:500`; explicit undo tests per step; H keeps typing bit-identical |
| Composition/autocorrect interference (Variant P only) | MED | `view.composing` + `composition`-meta guards; primary reason H is recommended |
| Over-conversion on paste (prose or rich HTML re-parsed) | MED | `hasMarkdownStructure` gate + rich-slice skip (§4.4) + code-block skip; regression tests exist (`markdownPaste.test.ts` prose/HTML cases) |
| Rule-order regression (formula vs markdown vs link) | MED | Ordering encoded once + the §5.4 registration-order test |
| Infinite append loop | LOW | Triple guard §5.2; `uniqueBlockIdPlugin` precedent shows attr-only appends are safe |
| Typing-feel regression | LOW | Same bounded regex pass as today, one plugin instead of two; no parser on the keystroke path |
| Deck Enter parity change (D5) surprises muscle memory | LOW | Verify current behavior on-device first; change is opt-in via D5 |

---

## 9. OPEN DECISIONS for Jim

**D1 — Delivery variant: Hybrid (H) vs Pure appendTransaction (P).** *(§3.3)*
**Recommend H:** one shared runner + generic per-surface call sites; `appendTransaction`
reserved for paste/bulk. Same define-once property, native typing semantics bit-identical,
no self-dispatch risk. P is fully specced above if you want maximal transaction-level purity.

**D2 — Paste architecture.** Pipeline-bulk (insert-then-convert in `appendTransaction`,
recommended: kills the `handlePaste` ordering class and unifies the iOS `insertFromPaste`
path) vs keeping `handlePaste` conversion as a third thin call site of the shared core
(smaller change, keeps two delivery paths forever).

**D3 — Backspace reverts the last auto-format.** Not current behavior (`undoInputRule` was
never bound). **Recommend ADD** via the edit surface (works on the Deck too — first
registrant in the backspace chain); it's the standard escape hatch for unwanted `- `→list.
Feel-flagged: trivially removable if it annoys.

**D4 — Voice transcripts through insert transforms?** **Recommend NO** (leave
`commitTranscript` untagged): transcripts are prose; a stray `- ` conversion mid-dictation
is worse than no conversion. Revisit as an explicit `{kind:'bulk'}` tag if wanted later.

**D5 — Deck Enter chain parity.** Deck runs `baseKeymap['Enter']` only (`deckAdapter.ts:53`),
missing `titleEnter`/`splitListItem` (`keymap.ts:105-112`). **Recommend unify** in step 3
(both surfaces consume one compiled Enter chain) after an on-device check of current Deck
list/title Enter behavior — if it's currently broken, this is a third shipped dual-wire bug.

**D6 — Sentence-space / auto-cap stay Deck-local.** **Recommend YES:** they are keypad
*intent* features driven by tap-timing state (`Keypad.tsx:111-120`), not document transforms;
native keyboards implement their own. Only `linkifyTrailingUrl` moves out of
`sentenceSpace` (it rides the space insert-rule after step 3, making the double-space path's
manual call redundant — delete it then).

**D7 — Smart typography (em-dash, ellipsis, smart quotes).** `prosemirror-inputrules` ships
them; deltos never enabled them. **Recommend out of scope** — but note the pipeline makes
adding them a one-line registration if ever wanted.
