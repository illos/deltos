# Spec — UI / Visual Refresh (v1 "final UI")

**Status:** ACTIVE — all open decisions resolved (see §0). Building Deploy-1 (Lane 2). Author: navSys
(navSys-2 drove the build; handed to navSys-3 on 2026-06-20 — see §0 HANDOFF).
**Canonical design reference:** `docs/design/ui-refresh/` (the Claude-Design handoff packet —
README = the hi-fi spec; `screenshots/` = intended look; `Deltos Rich Text.dc.html` = primary
interactive reference; `icons/` = brand assets). The `.dc.html` / `support.js` / `ios-frame.jsx`
are **references only — never shipped into the app** (recreate in the real stack).

Replaces the long-parked "visual UI-refresh" roadmap item. Pivot context: we've been building
functional screens toward "basic notes, day-to-day usable" (Settings just shipped); this is the
**final look-and-feel pass** that replaces the emoji-placeholder / dark-only ad-hoc shell with the
designed system. **Standing guardrail: must not regress the load-feel** (`render-before-data`,
tiny critical bundle, no heavy deps — `[[performance-is-a-standing-value]]`).

---

## 0. Build status + HANDOFF (navSys-2 → navSys-3, 2026-06-20)

> **📋 HANDOFF — navSys-3, start here.** You're inheriting the **UI visual-refresh workstream** that
> navSys-2 was driving with **devSys-2** (planner-coordinates-the-dev-directly model the user set up;
> NOT the usual hand-to-pilot path). This spec + its 3 sub-specs are the whole brain — nothing critical
> is only in chat:
> - `docs/specs/ui-visual-refresh.md` (THIS file) — master scope, decisions, lane plan, deploy gating.
> - `docs/specs/ui-tokens-and-fonts.md` — Lane 0 foundation (built; reference).
> - `docs/specs/ui-lane5-appearance-and-brand.md` — **Deploy 2 turnkey** (appearance picker + brand + lazy voices).
> - `docs/specs/ui-lanes34-editor-toolbars-markdown.md` — **Deploy 3 turnkey** (editor toolbars + markdown-light).
> - `docs/design/ui-refresh/` — the canonical Claude-Design packet (README + screenshots + prototypes + icons).
>
> **Decisions LOCKED (don't reopen):** cadence = 3 staged deploys, order **New look → Appearance+brand →
> Editor tools** (#3); fonts self-hosted + SW cache-forever, non-default voices lazy (#4); default
> **Ember × Sans × system**, palette/voice are placeholder for a future onboarding flow, mode firm =
> light/dark/system w/ system default (#5); iOS **≥16px inputs** (`[[ios-input-16px-no-zoom]]`).
>
> **Immediate next action for you:** devSys-2 is mid-Lane-2 on the `ui-refresh` worktree — **Pass B is
> scoped + worktree-ready but NOT yet coded** (the last stretch was eaten by Pass A + the worktree
> migration + the #52 deconfliction). So the live build is at Pass A. Pick up by getting Pass B (3-region
> shell + drag-resize handle + mobile sheet) moving, then C (nav) → D (list) → E/F (icons + ≥16px inputs)
> to complete Deploy-1. devSys-2 reports to you now.

> **DEPLOY GATE (Deploy-1):** ✅ the P0 data-loss blocker is **CLEARED** — **#52 is DONE, secSys-PASSED
> (@e4bae75) and USER-VERIFIED live** (pilot-2 closed the incident). The remaining gate is **Jim's design
> pass on the new look** (he wants to feel/approve it) + Lane 2 actually being complete. Live deploy still
> follows the integration steps below (the `ui-refresh` restyle must be brought onto clean mainline).
> eslint config fixed @5360d6e (rules-of-hooks gate live). Team: devSys (data/#52, done) · devSys-2
> (UI/Lane 2, on `ui-refresh` worktree) · gruntSys + navSys-1 (settings/auth/All-Notes lane — NOT ours) ·
> secSys (audit) · pilot-2 (orchestrator).

- **Lane 1 — Icon system:** ✅ DONE + pushed @2fad87d. 27 tree-shakeable inline-SVG components in
  `packages/client/src/icons/` (geometry lifted from the prototype), render test, ~1.6KB gzip whole set
  (0B until imported). New files only.
- **Lane 0 — Token foundation + fonts + themeStore:** ✅ DONE + pushed @db6b53c. `src/theme/tokens.css`
  (12 tokens × 4 palettes × light/dark + system via prefers-color-scheme + 4 voice scales + invariants),
  `src/db/themePointer.ts` (device-local IDB), `src/lib/themeStore.ts` (Zustand, applies data-attrs,
  lazy-voice loader seam), self-hosted Plex Sans+Mono woff2, render test (292/292 green, prod-clean).
  Bundle: tokens ~3.3KB + store ~0.7KB gzip; 7 woff2 ~136KB precached once → cache-forever. Mono body
  bumped 15→16px (iOS rule). Newsreader δ-wordmark + the 3 lazy voice files deferred to Lane 5.
- **⚠️ Branch isolation (2026-06-20):** the 4 Lane commits (db6b53c, 2fad87d, f9aed1d, 1d76c3d) landed
  on `phase-0-foundation` — the SAME branch pilot deploys #52 from — so they interleaved with the #52 fix
  and would have flipped the live app to the half-finished restyle. Resolution: pilot ships #52
  **deconflicted** (excludes those 4 commits); **remaining UI work (Pass B onward) moves to an isolated
  `ui-refresh` branch/worktree** so no more Lane commits ride the deploy mainline.
  - **#52 SHIPPED LIVE** deconflicted (worker ver 0793931a — verified no Ember/IBM-Plex/--paper in the
    live bundle, dark look intact). P0 notes-vanishing fixed live.
  - **Mainline cleaned (`fcc49ed`, pushed):** the 4 Lane commits **reverted** on `phase-0-foundation`
    (revert, NOT rebase — shared-history rewrite is unsafe with multiple live sessions; clean apply, no
    conflicts, build-hook passed). Mainline is now functional-only (dark look preserved) → future
    #52-class deploys are clean, no deconfliction needed. Restyle preserved on `ui-refresh`.
  - **⚠️ UI Deploy-1 integration (revert-the-revert trap):** mainline now carries reverts of the 4 Lane
    commits, so a **plain merge of `ui-refresh` would KEEP the reverts** (restyle would NOT reappear). At
    integration: either **(a) revert-the-reverts on mainline** (re-introduce the 4) then merge Pass B–E,
    or **(b) cherry-pick / rebase the complete restyle fresh** onto then-current mainline-HEAD. devSys-2
    owns this. Ships only after #52 verified live + the design pass with Jim.
- **Lane 2 — Shell + nav + note list restyle:** 🔨 IN FLIGHT on the `ui-refresh` worktree (completes
  Deploy 1). **Pass A ✅ DONE** (@f9aed1d mode-aware critical-CSS flash fix + @1d76c3d full styles.css
  retokenize sweep — whole client on the 12-token model, zero legacy vars, 311/311 green). **Pass B ⏳
  SCOPED + worktree-ready but NOT YET CODED** (3-region desktop shell: nav ~222 | list ~300 resizable |
  note + the `--handle` drag pill; mobile push-subscreen + bottom-sheet restyle; routed-tree render
  tests). Then C (NavContent×3 containers) → D (note list: full-bleed rows, selected-row, compose-in-
  header, search) → E (icon swap-in) → F (≥16px inputs). eslint step-0 fix already landed @5360d6e.
- **Lane 5 (appearance picker + brand + lazy voices) → Deploy 2:** 📋 SPEC-READY, turnkey →
  `docs/specs/ui-lane5-appearance-and-brand.md`. Builds on `ui-refresh`. Key gotchas it flags: δ-subset
  must come from upstream full Newsreader (fontsource latin lacks Greek); vite precache glob omits woff2;
  `theme.render.test` asserts no-newsreader-woff2 (relax it); index.html also touched by Lane 2 (land after).
- **Lanes 3+4 (editor toolbars + mobile grouped bar + markdown-light) → Deploy 3:** 📋 SPEC-READY, turnkey
  → `docs/specs/ui-lanes34-editor-toolbars-markdown.md`. Largest remaining build. Flags: builds on
  `ui-refresh`; mark name = `strikethrough`; Title button/`# ` map to a body h1 (unified-title constraint);
  open calls for pilot/navSys-3 — image button as stub, link via prompt v1, B/I/U/S glyph-vs-icon.

## 1. What the packet contains (inventory)

1. **Theme system (the core).** Two independent axes + mode: **4 palettes** (Bone, Graphite,
   Manila, Ember) × **4 type voices** (Serif/Newsreader, Sans/IBM Plex Sans, Mono/IBM Plex Mono,
   Grotesk/Space Grotesk) × **light/dark** = 32 combos. **Product default = Ember × Sans × system**
   (user decision #5 — overrides the packet's Graphite default). All driven by **CSS custom properties**
   on a theme root; switching = swapping var values on one ancestor (instant paint, no reload).
   - **12 color tokens** per palette×mode (exact hex in packet README §Color tokens):
     `--paper --list --nav --border --ink --body --secondary --faint --sel --accent --handle --sync`.
   - **Per-voice type scale** (packet §Typography): `--ff --h1/--h1w --h2 --note/--line --lt/--ltw
     --nav-item/--nav-itemw --quote --list-note`.
   - **Hard invariants (never vary):** metadata is **always IBM Plex Mono**; the synced dot is
     **always green `--sync`** (never the accent); the **δ wordmark glyph is always Newsreader serif**
     in `--accent`.
2. **Three-region shell** — Nav · Note list · Active note — composed per device:
   desktop = persistent left nav pane │ list │ note with a **drag-to-resize handle** between list and
   note; mobile = list is main screen, note is a **pushed sub-screen**, nav is a **drag-up bottom
   sheet** (never an edge-swipe drawer). One `NavContent`, three containers (pane / sheet / full-screen
   cold-start).
3. **Note list** — full-bleed rows (no cards): title line + (smart date + one-line preview); selected
   row = `--sel` + 2px `--accent` left border; persistent search field; **compose lives top-right of
   the list header on desktop** (not a FAB).
4. **Active note / editor** — meta toolbar (edited-time · green Synced dot · version-history icon · ⋯),
   a **formatting toolbar** (block styles Title/Heading/Subhead/Body/Mono · inline B/I/U/S/highlight/
   code/link · lists bullet/number/checklist · blocks quote/divider/image), centered 600px body column.
5. **Mobile editor bar — grouped & contextual** (the key mobile pattern): main row = **Aa**(Style) ·
   **B**(Format) · **☰**(Lists) · **+**(Insert) on the left, **Undo/Redo** on the right (divider
   between); tapping a group reveals a **sub-row above** with that group's controls, active group turns
   `--accent`.
6. **Mobile bottom nav** — extensible **action-slot row** (New · Undo · Redo · Search), grab-handle
   pill → drag up to the Nav sheet, safe-area aware.
7. **Rich text + markdown-light** — markdown-light **input rules** (`# `, `## `, `**b**`, `==hl==`,
   `[]`, `> `, ` ``` `, `---`, etc.) + toolbar + keyboard shortcuts, each round-tripping to Markdown
   (export/import mapping; **not** stored as markdown). Title = first heading node (unified). Full
   feature/trigger/export table in packet §Rich text. **Tables explicitly OUT of scope.**
8. **Appearance settings surface** — the real shipped picker (palette × type × light/dark/system).
9. **Brand assets** — the gold serif **δ** app icon + full favicon/PWA/apple-touch set in
   `docs/design/ui-refresh/icons/`.

---

## 2. How it maps onto the current codebase

Codebase facts from the architecture map (2026-06-20). Styling today = single `styles.css` (~1798
lines, BEM, plain CSS) + critical inline CSS in `index.html`; **one dark-only theme**
(`--bg/--fg/--muted/--edge`, accent `#4a6cf7`); **system fonts only**; emoji/Unicode icons; editor has
**undo/redo only, no formatting toolbar, no mobile grouped bar, no markdown-light**.

| Design area | Existing seam | Graft assessment |
|---|---|---|
| Theme tokens | `styles.css` + inline `index.html`, ad-hoc `--bg/--fg/--muted/--edge` | **NEW token system.** Rename/replace to the 12-token model; add light mode + 4 palettes + 4 voices as `[data-palette][data-mode][data-voice]` var blocks. Touch both `styles.css` **and** the critical inline CSS. Medium. |
| Fonts | system-ui only | **NEW.** Load 4 Google families — but **load-feel risk**: self-host/subset + lazy-load non-default voices (see Decision C). |
| Shell / 3 regions | `App.tsx` `AuthedShell`/`HomeView`, `DrawerNav`, `BottomNav`, `views/NavContent`, `AllNotebooksScreen` | **Mostly reuse.** `NavContent` is already the composable "build once, 3 containers" component the packet asks for. Restyle, don't rewrite. Add the **desktop list↔note resize handle** (new). |
| Note list | `HomeView` + `SwipeRow` + `lib/notePreview` | Reuse; restyle rows to full-bleed token model; **move compose to list-header top-right on desktop** (currently a blue FAB). Keep swipe gestures. |
| Editor shell | `editor/NoteEditor` + `editor/ProseMirrorEditor` + `schema.ts` | Reuse the unified-title PM doc. **Big new build:** formatting toolbar (desktop) + grouped mobile bar + wiring commands to selection state. |
| Editor marks | `schema.ts` has bold/italic/code/link | **Add marks:** underline, strikethrough, highlight (`<mark>`). `code_block`(Mono), `todo_item`(checklist), `blockquote`, `horizontal_rule` already exist. |
| Markdown-light | none | **New** prosemirror-input-rules set, mapped to the packet table. Pairs with block-id plugin + unified title — validate on-device. |
| Undo/Redo | landed (`#44`, history plugin + depth-driven buttons) | **Reuse** — re-skin the buttons as icons; surface in desktop toolbar + mobile main row + mobile bottom-nav action slot. |
| Icons | emoji/Unicode inline | **New** hand-rolled inline-SVG icon components (~24, fine-line 1.4–1.6px stroke, `currentColor`, 24px grid). No icon font/lib (reuse-discipline + perf). |
| Settings | `routes/SettingsRoute.tsx` (Account/Security/About, lazy-loaded) | **Add an Appearance section** (theme picker) — slot between Account and Security; reads/writes the new theme store. |
| Theme state | none | **New Zustand `themeStore`**, persisted **device-local in IndexedDB** (mirror `notebookStore`/`notebookPointer` pattern — survives eviction; not synced, not localStorage). |
| PWA / icons | `public/icons/*`, manifest via `vite-plugin-pwa`, `index.html` links | Swap in the new brand icons; update manifest `icons[]` (any/maskable) + apple-touch + favicon; update `theme-color` to be mode-aware. |
| Parked bottom-nav/search bundle (#31–38) | committed on-branch, not deployed | **Reconcile:** the packet's bottom-nav action row (New/Undo/Redo/Search) + drag-up sheet supersede/refine that parked work — build the design on top of it, don't double-build. |

**Two structural cautions:** (a) critical CSS is duplicated in `index.html` — every chrome/token
change lands in both places; (b) the unified title-in-document is foundational — the toolbar drives PM
commands, it does **not** reintroduce a separate title field.

---

## 3. Proposed decomposition (lanes for pilot → devSys-2 + subagents)

Sequenced so each lane is independently reviewable on the **live** site (review-on-live rule).

- **Lane 0 — Token foundation & fonts** (gates everything): the CSS-custom-property theme system
  (12 tokens × 4 palettes × light/dark + 4 voice type-scales), the font-loading strategy, `themeStore`
  (IDB-persisted) + theme-root application. No visual feature yet — just the substrate + default
  (Ember × Sans × system). *Render tests: theme swap flips vars; default applies.*
- **Lane 1 — Icon system**: ~24 hand-rolled inline-SVG components at the spec stroke weights. Parallel
  with Lane 0; both feed everything downstream.
- **Lane 2 — Shell + Nav + Note list restyle**: apply tokens to `AuthedShell`/`HomeView`/`NavContent`/
  `DrawerNav`/`BottomNav`; desktop resize handle; compose→list-header; bottom-nav action-slot row;
  drag-up sheet polish. *Render tests: 3-region desktop, mobile push/sheet, selected-row treatment.*
- **Lane 3 — Editor toolbars + new marks**: desktop formatting toolbar + mobile grouped contextual bar
  (Aa/B/☰/+ groups + sub-rows + active-accent), undo/redo re-skinned, schema marks U/S/highlight,
  selection-driven active states. *Render tests: toolbar groups, sub-row open/close, mark toggles.*
- **Lane 4 — Markdown-light input rules**: the input-rule set per the packet table + keyboard
  shortcuts; on-device validation with block-id + unified title. *Tests: each trigger → node/mark.*
- **Lane 5 — Appearance settings + brand assets**: the Appearance picker in `/settings`; swap PWA/
  favicon/apple-touch icons + manifest + mode-aware theme-color.

**Deploy grouping (per Decision A):** Deploy 1 = Lanes 0+1+2 ("new look"); Deploy 2 = Lane 5
("appearance + brand" — picker needs Lane 0's tokens, builds on Deploy 1); Deploy 3 = Lanes 3+4
("editor tools", the largest/riskiest, last). Lanes 0+1 are the foundation; 2 starts as 0 lands. Lanes
3+4 overlap the milestone's "editor-tools + markdown-light" item — **this packet is now that item's
vehicle**. Each lane: render-tests + green + prod-tsc + **bundle-delta report** (load-feel gate) before
its deploy.

---

## 4. Open decisions (surfaced to the user on the bulletin)

- **A — Delivery cadence. ✅ RESOLVED (user, #3):** staged in **3 deploys**, with the original 2 and 3
  **flipped** (appearance+brand ships before editor-tools). Deploy order:
  - **Deploy 1 — "New look":** Lanes 0 (theme tokens + fonts) + 1 (icons) + 2 (shell/nav/list restyle).
    Ships the new default look (Ember × Sans, picker not yet user-facing).
  - **Deploy 2 — "Appearance + brand":** Lane 5 (the Appearance theme picker in Settings + new app/
    favicon/PWA icons). Now the user can switch all 32 combos + sees the gold-δ brand.
  - **Deploy 3 — "Editor tools":** Lanes 3 (formatting toolbars + grouped mobile bar) + 4 (markdown-
    light input rules). The largest/riskiest build, last.
- **B — Default appearance. ✅ RESOLVED (user, #5):** default = **Ember × Sans × system** (mode =
  follow-system with manual light/dark override). NOTE: this **overrides the packet's stated Graphite
  default** — user prefers the Ember palette (charcoal / vermilion, "ultra-modern") with the Sans voice
  (IBM Plex Sans). All 32 combos remain available in the Appearance picker. Implementation: the theme
  root boots to `palette=ember`, `voice=sans`, `mode=system` (resolves to the OS light/dark at runtime).
  **Bulletin refinement (user):** the palette/voice boot value "doesn't matter" — a **future
  onboarding flow will let the user choose palette + voice**, so treat ember/sans as a placeholder boot
  default and keep `setPalette`/`setVoice` fully working for that later onboarding override. The firm
  part is **mode = light / dark / system, with system the default.**
- **C — Font loading vs load-feel. ✅ RESOLVED (user, #4):** priority is **everyday fast load over
  first-ever load**; active fonts must be **permanently cached on device**. Plan:
  **self-host** the font files (subset woff2, same-origin — not Google's CDN: reliable caching,
  offline-capable, no third-party request) with `font-display:swap`; the **service worker**
  (already present via vite-plugin-pwa/workbox) caches them **cache-first with no expiry** → permanent
  on-device, persists across deploys (content-hashed; only re-downloads if the file itself changes).
  **Default voice (IBM Plex Sans) + IBM Plex Mono (mandatory metadata) are precached at SW install** so
  the *first everyday* load is instant. The other 3 voices are **fetched once when first selected, then
  permanently cached** — a one-time cost per voice, instant forever after. First-ever app load pays the
  default-font download once (acceptable per user). Net: everyday load = fonts from cache, zero network.

---

## 5. Guardrails (carried into every lane)
- **Load-feel is a hard gate** — render-before-data, tiny critical bundle, lazy heavy bits, **no new
  heavy deps**; report bundle delta on every hand-back.
- Build Nav / Note list / Active note as **independent composable components** (multi-pane and
  mobile sheet/full-screen are compositions, not rewrites).
- Keep the **view-resolution seam** intact (one collection view = list, one item view = doc editor);
  this is styling + editor toolbars, **not** a model change.
- Reuse-discipline: recreate the design natively in React 19 / our stack; never port `.dc.html` /
  `support.js` / `ios-frame.jsx`. No heavy icon font / animation lib.
- Theme persistence = device-local IDB (not synced v1; cross-device theme sync = future).
- **iOS-zoom guard (HARD, user-flagged):** iOS Safari auto-zooms the viewport when a focusable form
  field (`<input>`/`<textarea>`/`<select>`) has computed `font-size < 16px`. So **all real text inputs
  must render at ≥16px** even where the mock shows smaller — notably the **persistent search field**
  (packet says 13px → render the *input element* at 16px; style the surrounding chrome to keep it
  visually compact) and the **new-notebook input**. Also verify the editor: 3 of 4 voices have body
  ≥16px, but **Mono voice body is 15px** — bump to 16px or verify the contenteditable doesn't zoom
  on-device. Do NOT rely on `maximum-scale=1`/`user-scalable=no` to suppress it (accessibility +
  unreliable). The ≥16px rule wins over the mock's smaller input type sizes.
