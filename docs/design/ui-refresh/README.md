# Handoff: deltos — UI / Visual Refresh

## Overview
This packet specifies the **visual + interaction design** for **deltos**, a local-first, offline-first PWA notes app ("one substrate, many surfaces"). It covers the three-region shell (Nav · Note list · Active note) on **desktop and mobile**, a **themeable appearance system** (4 palettes × 4 type voices × light/dark), the **note editor** with full rich-text formatting + markdown-light, and brand **app/favicon** assets.

The current near-term milestone is "basic notes, day-to-day usable." This refresh replaces the emoji-placeholder / unstyled shell with the look-and-feel below. **It must not regress the load-feel** (deltos's standing performance value: render-before-data, tiny critical bundle, no heavy deps). Nothing here requires an animation or component library — it's flexbox/grid, inline-ish styles, system-friendly webfonts, and hand-rolled SVG icons.

---

## About the Design Files
The files in this bundle are **design references created in HTML**, not production code to copy verbatim. They are "Design Components" (`.dc.html`) — self-contained prototypes that render the intended look and behavior. **Your task is to recreate these designs in deltos's real codebase** — **React 19 + React Router 7 + Vite + TypeScript**, with **ProseMirror** as the editor and **Zustand** for UI state — using its established patterns. Do **not** ship the `.dc.html` files or their runtime (`support.js`) into the app.

How to view the references:
- Open `Deltos Rich Text.dc.html` in a browser — the **primary** reference. It shows the desktop 3-pane shell and the mobile phone, with a live editable note, the full formatting toolbars, the grouped mobile editor bar, and a complete rich-text **reference table**. The controls at the top switch palette / type / mode / mobile-view live.
- Open `Deltos Mixer.dc.html` — the same shell focused on **theme exploration** (palette × type × light/dark), and a preview of the future **Appearance settings** surface.
- `ios-frame.jsx` is only the device bezel used to frame the mobile mock; **do not port it** — render mobile screens in your normal responsive layout / device testing.

## Fidelity
**High-fidelity (hi-fi).** Colors, typography, spacing, and interactions are final and intended to be matched closely. Exact hex values, font families, sizes, weights, and the token names are listed below. Recreate pixel-close using real React components and deltos's conventions. Pixel dimensions in the mock (e.g. the 1040×700 desktop card, 222/300px panes) are **proportional references** — the real desktop layout is a resizable multi-pane window (see Layout). Honor the *ratios, spacing, type, and color*, not the literal frame size.

---

## The Theme System (core)

Appearance is **two independent axes plus mode** — this is a real shipped setting (the Appearance screen) and also the structure to build theming around:

- **Palette / vibe (4):** `Bone` (warm paper, ochre) · `Graphite` (cool slate, indigo — the default/home base) · `Manila` (typewriter, ribbon-red) · `Ember` (charcoal, vermilion — ultra-modern).
- **Type voice (4):** `Serif` (Newsreader) · `Sans` (IBM Plex Sans) · `Mono` (IBM Plex Mono) · `Grotesk` (Space Grotesk).
- **Mode:** Light / Dark (offer "follow system" + manual override in the real app).

That's 4 × 4 × 2 = 32 combinations from clean axes. **Default: Graphite × Sans × Light.** (The Rich Text reference file opens on Ember × Grotesk to show the newest direction; treat Graphite × Sans as the product default.)

### Implementation model
Drive everything from **CSS custom properties** set on a theme root (e.g. `<body data-theme>` or a provider). The palette+mode supplies the color vars; the type voice supplies the font + type-scale vars. Switching a theme = swapping the variable values on one ancestor; all components read `var(--x)`. This is exactly how the prototype works and it keeps paint instant.

**Invariants across every theme (do not vary):**
- **Metadata is always IBM Plex Mono** — dates, note counts, section labels (`NOTEBOOKS`), the `deltos` wordmark text, sync status text. Small, often uppercase with ~1.5px letter-spacing for labels.
- **Sync/“synced” dot is always green** (its own `--sync` token), never the accent — "saved" must never read as "alert."
- The **δ wordmark glyph is always Newsreader serif** in the accent color, regardless of the chosen type voice.

### Color tokens (exact)
CSS var names used in the prototype: `--paper` (editor/page surface), `--list` (note-list surface), `--nav` (nav/sidebar surface), `--border` (hairlines), `--ink` (primary text), `--body` (body text), `--secondary` (secondary text/icons), `--faint` (tertiary/placeholder), `--sel` (selected-row / subtle fill), `--accent`, `--handle` (resize/grab handle), `--sync` (synced dot).

**Bone — light**
`paper #FAF7F0 · list #F3EEE4 · nav #EAE4D8 · border #E0D8C8 · ink #25201A · body #3A332A · secondary #8A8170 · faint #A0967F · sel #EBE1CF · accent #A8662F · handle #D8CFBD · sync #7FA86B`
**Bone — dark**
`paper #26211A · list #221E18 · nav #1C1813 · border #332E25 · ink #EDE6D8 · body #D8D0C0 · secondary #9C9484 · faint #857C6A · sel #2E281F · accent #C98A4A · handle #3A3429 · sync #8FBE78`

**Graphite — light**  *(product default)*
`paper #FFFFFF · list #F7F8FA · nav #F0F1F3 · border #E5E7EB · ink #1A1C1F · body #33373D · secondary #6B7177 · faint #8A9099 · sel #E7EBF3 · accent #3B5BDB · handle #D2D6DC · sync #3BA776`
**Graphite — dark**
`paper #202225 · list #1B1D1F · nav #161719 · border #2C2F33 · ink #E6E8EB · body #C4C8CD · secondary #8B9197 · faint #777E85 · sel #23304D · accent #5B7BFF · handle #34383D · sync #42C28C`

**Manila — light**
`paper #F8F7F0 · list #F2F0E7 · nav #E8E6DD · border #DFDACE · ink #2B2722 · body #423C33 · secondary #877F70 · faint #A89F8C · sel #EAE0CF · accent #9E3B2E · handle #D5CFC0 · sync #7B9A66`
**Manila — dark**
`paper #25221B · list #201E18 · nav #1A1813 · border #322D24 · ink #E8E2D4 · body #CBC3B3 · secondary #968D7C · faint #857C6A · sel #2D281F · accent #C75A48 · handle #3A3429 · sync #8FAE74`

**Ember — light**
`paper #FFFFFF · list #F7F7F8 · nav #F2F2F4 · border #E7E7EB · ink #17171A · body #36363B · secondary #6E6E76 · faint #A0A0A8 · sel #FBEAE4 · accent #EE431C · handle #D6D6DA · sync #1FA971`
**Ember — dark**
`paper #1A1A1D · list #161618 · nav #111113 · border #2A2A2E · ink #F0F0F2 · body #C8C8CE · secondary #9A9AA3 · faint #6E6E77 · sel #2E211D · accent #FF6242 · handle #34343A · sync #34C98A`

Highlight mark (`<mark>`): `background: color-mix(in srgb, var(--accent) 24%, transparent)`; text stays `inherit`.

### Typography (fonts + type scale per voice)
All four are Google Fonts. Load weights 400/500/600 (+700 for Sans/Grotesk). **IBM Plex Mono is always loaded** (metadata) regardless of voice.

Google Fonts: `Newsreader` (opsz 16..72, ital 0/1, wght 400;500;600), `IBM Plex Sans` (400;500;600;700), `IBM Plex Mono` (400;500;600), `Space Grotesk` (400;500;600;700).

Per-voice scale (var names: `--ff` body/UI font, `--h1`/`--h1w` note title, `--h2` heading, `--note`/`--line` body copy, `--lt`/`--ltw` list-row title, `--nav-item`/`--nav-itemw` nav item, `--quote`, `--list-note` checklist/inline-list text):

| Voice | --ff | --h1 / wt | --h2 | --note / line | list title --lt / wt | nav item / wt |
|---|---|---|---|---|---|---|
| **Serif** | `'Newsreader',Georgia,serif` | 36px / 600 | 21px | 17.5px / 1.65 | 15px / 600 | 15px / 400 |
| **Sans** | `'IBM Plex Sans',system-ui,sans-serif` | 33px / 700 | 19px | 16.5px / 1.62 | 14.5px / 600 | 14.5px / 500 |
| **Mono** | `'IBM Plex Mono',ui-monospace,monospace` | 27px / 600 | 17px | 15px / 1.75 | 13.5px / 600 | 13.5px / 400 |
| **Grotesk** | `'Space Grotesk',system-ui,sans-serif` | 32px / 600 | 19px | 16px / 1.58 | 14.5px / 500 | 14.5px / 500 |

Heading `--h2` weight 600; subheading (h3) ≈ `calc(var(--h2) * 0.84)` weight 600. Note titles use a slight negative letter-spacing (≈ -0.015em). Metadata: IBM Plex Mono 10–11px, secondary/faint color, labels uppercase + ~1.5px tracking.

---

## Screens / Views

### Layout overview (three composable regions)
The shell has three regions — **Nav**, **Note list**, **Active note** — composed differently per device class:
- **Desktop / tablet-landscape:** Nav as a persistent **LEFT PANE** │ Note list │ Active note, with a **drag-to-resize handle** between list and note. (Reference proportions: nav ≈ 222px fixed, list ≈ 300px resizable, note fills the rest. Real app: panes resizable; nav-pane collapse is TBD.)
- **Mobile / tablet-portrait:** Note list is the **main screen** (edge-to-edge); Active note is a **pushed sub-screen** (back returns to list); Nav opens as a **bottom sheet** (drag-up), NOT a side drawer (avoids iOS edge-swipe conflict).
- **Cold-start with no valid current notebook:** Nav content rendered full-screen (the all-notebooks landing).

---

### 1. Desktop — Nav pane
- **Surface** `--nav`, right border `1px var(--border)`, padding `20px 13px`, vertical flex.
- **Wordmark** (top, padding `2px 8px 20px`): `δ` in **Newsreader serif 24px/600, color `--accent`** + `deltos` in **IBM Plex Mono 13px**, `--ink`, ~1px tracking, 9px gap.
- **Section label** `NOTEBOOKS` — Plex Mono 10px, `--faint`, 1.5px tracking, padding `4px 8px 10px`.
- **Notebook rows** — flex row, gap 10px, padding 8px, radius 7px. Each: a 15px line **notebook icon** (rounded rect + spine line) + name (`--ff`, `--nav-item`/`--nav-itemw`, flex:1) + count (Plex Mono 11px). 
  - **Current notebook:** background `--sel`, text `--ink`, icon stroke `--accent`, count `--secondary`.
  - **Others:** transparent bg, text `--body`, icon stroke `--secondary`, count `--faint`.
  - Sample data: `Field Notes 24` (current) · `Reading 8` · `deltos 17` · `Garden 6` · `Letters 3`.
- **+ New notebook** row — plus icon + label (Plex Mono 12px), `--secondary`.
- **Spacer** (flex:1), then a top-bordered footer group: **Trash** (trash-can icon) and **Settings** (sliders icon), Plex Mono 12px, `--secondary`.

### 2. Desktop — Note list pane
- **Surface** `--list`, right border `1px var(--border)`, `position:relative`.
- **Header** (padding `18px 18px 0`): left = notebook name (`--ff` 20px/600, `--ink`, nowrap) above "N notes" (Plex Mono 11px, `--faint`); right = **New-note compose button** (compose/edit icon, ~21px, stroke `--accent`). *(The compose action lives here, top-right of the list — not a floating FAB on desktop.)*
- **Persistent search field** (padding `12px 16px`): a rounded field — surface `--paper`, `1px var(--border)`, radius 9px, padding `7px 11px` — with a 15px magnifier (`--faint`) + placeholder "Search" (`--ff` 13px, `--faint`).
- **Rows (full-bleed, no card):** padding `12px 18px`, bottom hairline `1px var(--border)`. Line 1 = title (`--ff`, `--lt`/`--ltw`, `--ink`, nowrap+ellipsis). Line 2 = smart date (Plex Mono 11px, `--secondary`, no-wrap) + 8px gap + one-line body preview (`--ff` 13px, `--faint`, nowrap+ellipsis).
  - **Selected row:** background `--sel`, **left border `2px var(--accent)`** (padding-left reduced to keep text aligned).
  - Title fallback: if `title` empty but body has text, show first words of body (display-only). Both empty → "Untitled".
  - Smart date format (Apple-Notes-style): today → time ("2:30 PM"); yesterday → "Yesterday"; this year → "Jun 12"; older → "Jun 12, 2024".
- **Resize handle:** a 3px-wide, 38px-tall, radius-2 pill in `--handle`, vertically centered on the right edge — the list↔note resizer.

### 3. Desktop — Active note (editor)
- **Surface** `--paper`, vertical flex.
- **Meta toolbar** (padding `15px 26px`, space-between): left = "Edited Yesterday at 4:32 PM" (Plex Mono 11px, `--faint`). Right cluster (gap 16px): **Synced** indicator (7px green `--sync` dot + Plex Mono 11px `--secondary` "Synced"), a **version-history** icon (clock-with-counterclockwise-arrow, 18px, `--secondary`), and an **⋯ overflow** (three dots, `--secondary`).
- **Formatting toolbar** (below meta, flex-wrap, gap ~3px, padding `8px 18px`, bottom hairline). Groups separated by a 1px×18px `--border` divider. Buttons: transparent, radius 6px, padding ~5–7px, icon/text in `--secondary`, hover bg `--sel`. Order:
  - **Block styles** (text buttons): `Title` (→ H1) · `Heading` (→ H2) · `Subhead` (→ H3) · `Body` (→ P) · `Mono` (→ code/pre block).
  - **Inline:** `B` (bold) · `I` (italic, serif glyph) · `U` (underline) · `S` (strikethrough) · highlight icon · inline-code icon (`</>`) · link icon.
  - **Lists:** bulleted · numbered · checklist.
  - **Blocks:** quote · divider · image/attachment. *(Tables intentionally excluded — see "Out of scope".)*
- **Body** (scrollable): centered column `max-width 600px`, generous padding (`~18px 40px 48px`). This is the ProseMirror document. Element styling uses the theme vars (see "Rich-text element styles").

### 4. Mobile — Home (note list)
- Status bar / safe-area at top. **Title** = current notebook name (`--ff` ~27px / `--h1w`, `--ink`) + "N notes" (Plex Mono 11px, `--faint`).
- **Rows:** same full-bleed pattern as desktop, slightly larger (title 16px/600, meta 11.5px mono + 13.5px preview). Selected row = `--sel` + 2px `--accent` left border.
- (iOS swipe-right on a row reveals Copy + Delete; hard-fling deletes — existing behavior, keep.)
- **Bottom nav bar** (pinned, surface `--nav`, top hairline, **safe-area-aware** bottom padding via `env(safe-area-inset-bottom)`). A small grab handle pill (`--handle`) sits centered at the top of the bar (drag up → Nav sheet). Action row (icon over Plex Mono 10px label): **New** (compose, `--accent`) · **Undo** · **Redo** · **Search** (`--secondary`). This is the extensible "action-slot row" — keep it data-driven so future actions/plugins can register.

### 5. Mobile — Active note (editor sub-screen)
Pushed over the list; back returns. 
- **Top bar:** back affordance `‹ Field Notes` (chevron + label, `--accent`, nowrap) on the left; right cluster = version-history icon + ⋯ (`--secondary`); bottom hairline.
- **Body:** date line (Plex Mono 11px `--faint`) then the editable note (theme-var styled). Scrolls.
- **Bottom editor bar — grouped, contextual** (the key mobile pattern):
  - **Main row:** four group icons on the left — **Aa** (Style) · **B** (Format) · **☰** (Lists) · **+** (Insert) — and on the right, separated by a 1px×22px `--border` divider, **Undo** and **Redo** (always available). Group icons are `--secondary`; the **active group turns `--accent`**.
  - **Sub-row:** tapping a group reveals a second row **above** the main row (surface `--sel`, bottom hairline) with that group's controls; tapping the active group again closes it.
    - **Style →** Title · Heading · Subhead · Body · Mono (text buttons)
    - **Format →** B · I · U · S · highlight · code
    - **Lists →** bulleted · numbered · checklist
    - **Insert →** link · quote · divider · image
- Safe-area bottom padding on the bar.

### 6. Mobile — Nav sheet (drag-up "Menu")
- The list dims behind a scrim (`rgba(0,0,0,.45)`); a sheet rises from the bottom (~76% height), surface `--nav`, top corners radius 22px, large soft shadow.
- Grab handle pill (`--handle`) centered at top; `NOTEBOOKS` label; the same notebook rows as desktop nav (current highlighted with `--sel`, icon `--accent`); `+ New notebook`; top-bordered footer with **Trash** + **Settings**.
- Dismiss on: select an item, swipe down, or tap the scrim. One Nav surface, three containers: **left pane** (desktop) / **bottom sheet** (mobile) / **full-screen** (cold-start) — build `NavContent` once.

---

## Rich text — features, triggers & Markdown export
The editor body is a structured block document (ProseMirror), **not stored as Markdown** — Markdown is an export/import mapping. Provide **markdown-light input rules** (type the trigger at the start of a line / inline) AND toolbar controls AND keyboard shortcuts. Each feature below: the trigger, how it round-trips to Markdown, and which control surfaces it.

| Feature | Type to trigger | Exports as | Control |
|---|---|---|---|
| Title | `# ` (the note's first heading) | `# Title` | "Title" / first-line style |
| Heading | `## ` | `## Heading` | "Heading" (H2) |
| Subheading | `### ` | `### Sub` | "Subhead" (H3) |
| Body | — (default) | plain text | "Body" (P) |
| Monospaced | toolbar | ` ``` ` fenced | "Mono" |
| Bold | `**text**` | `**text**` | B |
| Italic | `*text*` | `*text*` | I |
| Underline | toolbar | `<u>text</u>` (HTML — no MD equivalent) | U |
| Strikethrough | `~~text~~` | `~~text~~` | S |
| Highlight | `==text==` | `==text==` (or `<mark>`) | highlight |
| Inline code | `` `code` `` | `` `code` `` | `</>` |
| Link | `[text](url)` | `[text](url)` | link |
| Bulleted list | `- ` or `* ` | `- item` | • |
| Numbered list | `1. ` | `1. item` | 1. |
| Checklist | `[] ` / `[ ] ` | `- [ ]` / `- [x]` | ✓ |
| Quote | `> ` | `> quote` | " |
| Code block | ` ``` ` | ` ```lang … ``` ` | { } |
| Divider | `---` | `---` | — |
| Image / file | paste / drag | `![alt](hash)` (content-addressed) | image |
| Indent / nest | `Tab` (Shift+Tab outdent) | nested list | ⇥ |

Title is the **first heading node in the one document** (unified title — Enter flows title→body), and the `title` metadata is derived from it; never a separate input field.

### Rich-text element styles (theme-var driven)
Map ProseMirror node/mark rendering to these (matches the prototype's `[data-editor]` rules):
- `h1`: `--ff`, `--h1`, `--h1w`, `--ink`, line-height 1.15, letter-spacing -0.015em.
- `h2`: `--ff`, `--h2`, 600, `--ink`. `h3`: `calc(var(--h2)*0.84)`, 600, `--ink`.
- `p`: `--ff`, `--note`, `--line`, `--body`.
- `ul/ol`: `--ff`, `--note`, `--line`, `--body`, padding-left 24px.
- `blockquote`: `--ff` italic, `--quote`, `--secondary`, left border `2px var(--accent)`, padding-left 16px.
- `pre` (code block): IBM Plex Mono 13px, color `--ink`, background `--sel`, `1px var(--border)`, radius 8px, `white-space:pre-wrap`.
- inline `code`: IBM Plex Mono 0.88em, background `--sel`, padding 1px 5px, radius 4px.
- `a`: `--accent`, underline, 2px offset.
- `hr`: top border `1px var(--border)`, margin 20px 0.
- **Checklist item:** flex row, gap 11px; checkbox = 19px box, 1.6px `--faint` border, radius 6px; **checked** = `--accent` fill + white check glyph; checked label = `line-through` + `--faint`. Checkbox toggles on click/tap (the box itself, not the whole row entering edit).
- `mark`: highlight background (see above).

---

## Interactions & Behavior
- **Theme switching** is instant (swap CSS vars on the root). No reload. In-place reactive everywhere — never a full-page reload.
- **List → note:** desktop selects in-place (note pane updates); mobile pushes the note sub-screen, native swipe-back returns.
- **New note:** creates in the **current** notebook (desktop list compose button; mobile bottom-bar "New").
- **Nav (mobile):** drag-up handle or tap → sheet; dismiss on select / swipe-down / scrim tap. Never relies on an edge-swipe to open.
- **Editor toolbar (mobile):** tap a group → its sub-row appears above the main bar and the group icon goes `--accent`; tap again → closes. Undo/Redo always live on the main row.
- **Checkboxes** toggle on tap and strike their text.
- **Sync status:** synced/pending/failed/local-only per note; the green dot = synced. Conflicts surface as a non-blocking toast + badge (conflict-as-version), never a lost write.
- **Hover** (desktop): toolbar buttons get a `--sel` background; rows can get a subtle hover fill (use `--sel` at lower emphasis or a 4–6% ink tint).
- **Animations:** keep minimal and cheap — sheet slide-up, toolbar fade/slide of the sub-row, ~120–180ms ease. No animation library.

## State Management (UI)
- `theme = { palette: 'bone'|'graphite'|'manila'|'ember', font: 'serif'|'sans'|'mono'|'spaceg', mode: 'light'|'dark'|'system' }` — persisted (device-local). Default `graphite / sans / light` (or system).
- `currentNotebookId` — **device-local pointer in IndexedDB** (NOT synced, NOT localStorage — must survive weeks/eviction). Cold launch lands here; missing/dangling → all-notebooks screen.
- Mobile: `phoneView = 'home' | 'note' | 'menu'`; `activeNoteId`; editor `activeGroup = null | 'style' | 'format' | 'lists' | 'insert'`.
- Editor formatting state (which marks/blocks are active at the selection) drives toolbar active states.

## Design Tokens (summary)
- **Colors:** the 12 vars per palette×mode above.
- **Radii:** rows/buttons 6–9px; cards/panes 12–14px; sheet top 22px; checkbox 6px; app icon squircle ≈ 22.5% of size.
- **Hairline:** 1px `--border` everywhere (dividers, pane edges, toolbar edges).
- **Spacing:** nav/list row padding 8–12px vertical / 16–18px horizontal; editor body column max 600px; toolbar gaps ~3px (desktop) / space-around (mobile).
- **Type scale:** per-voice table above. Metadata always Plex Mono 10–11px.
- **Shadows:** panes/cards soft & low — e.g. `0 8px 30px rgba(50,42,28,.10)`; sheet `0 -16px 50px rgba(0,0,0,.4)`; keep subtle.

## Assets
- **App icon + favicon** in `icons/` — the brand icon: a tall serif **δ** in a champagne-gold gradient on a graphite-gradient square (full-bleed, no rounded corners baked in — the OS applies the mask). Full set, all derived from the 1000×1000 master `uploads/deltos.png`:
  - `icon-1024.png`, `icon-512.png`, `icon-192.png` — PWA manifest sizes.
  - `icon-maskable-512.png` — maskable (bg fills the square, safe for the maskable safe-zone).
  - `apple-touch-icon-180.png` — iOS home-screen.
  - `favicon-64.png`, `favicon-32.png` — browser tab.
  - The δ is `U+03B4`. Wire these into `manifest.webmanifest` (`icons[]` with `purpose: "any"` / `"maskable"`) and the `<link rel="apple-touch-icon">` / `<link rel="icon">` tags.
- **Icons (UI):** fine-line, ~1.4–1.6px stroke, `currentColor`, 24px grid, round caps/joins. Set used: search (magnifier), compose/new (square+pencil), pencil (mobile new), notebook (rounded rect + spine), plus, trash, settings (sliders), chevron, ellipsis, version-history (clock + ccw arrow), undo/redo (curved arrows), checkbox/checklist, bold/italic/underline/strike (glyphs), highlight, inline-code (`</>`), link, bullet-list, numbered-list, quote, divider, image, sync dot. Recreate with your icon system (e.g. inline SVG components) at these weights — do not pull a heavy icon font.

## Files (in this bundle)
- `Deltos Rich Text.dc.html` — **primary reference**: shell + live editor + toolbars + grouped mobile editor bar + rich-text reference table; themeable controls.
- `Deltos Mixer.dc.html` — theme explorer / future Appearance settings preview.
- `ios-frame.jsx` — device bezel used only to frame the mobile mock (do not port).
- `support.js` — the prototype runtime (lets the `.dc.html` files open in a browser; **not** for the app).
- `icons/` — app icons + favicons (see Assets).

## Out of scope / later (do not build now)
- **Tables** — deferred to a plugin; intentionally removed from toolbars, reference, and specimen.
- The **inline auto-replace** of `**bold**`→bold mid-typing was left out of the reference's live demo for reliability; the syntax is still specced above — implement via ProseMirror input rules.
- Keyboard shortcuts weren't enumerated in the mock; use platform conventions (⌘B/⌘I/⌘K, etc.) — the table's triggers + controls are the source of truth for *what* exists.
- The desktop formatting toolbar is one flat (wrapping) row in the mock; grouping it like mobile is optional.

## Guardrails
- Hold the **load-feel** standing value — render-before-data, lazy-load heavy bits, no new heavy deps for this UI.
- Build **Nav / Note list / Active note as independent composable components** so the wide-screen multi-pane and the mobile sheet/full-screen forms are compositions, not rewrites.
- Keep the **view-resolution seam** intact (one collection view = the list, one item view = the doc editor); this refresh is styling + the editor toolbars, not a model change.

## Screenshots (`screenshots/`)
Rendered from the reference prototype. They show intended look/framing, not exact pixel dimensions.
- `desktop-graphite-light.png` — default theme (Graphite × Sans, light): nav pane · note list (compose + persistent search) · editor with formatting toolbar.
- `desktop-ember-dark.png` — Ember × Grotesk, dark: same shell, ultra-modern palette.
- `mobile-home-graphite-light.png` — mobile home: title, search, full-bleed rows, bottom action bar (New · Undo · Redo · Search).
- `mobile-note-editor-style-group.png` — mobile note sub-screen with the grouped editor bar, **Style** sub-row open (Aa active in accent).
- `mobile-nav-sheet.png` — drag-up Nav sheet over the dimmed list (notebooks · New notebook · Trash · Settings).
- `reference-table.png` — the rich-text feature → trigger → Markdown-export table, themed.
