# Custom on-screen keyboard — spec & roadmap

Status: **Phases 1–2 + voice + spellcheck + custom dictionary SHIPPED — v1 live 2026-06-24.**
Background/rationale: memory `[[custom-keyboard-direction]]`. Probe #68 PASSED and REMOVED
(inputmode=none suppresses the iOS keyboard; kbprobe route cleaned up). Owner: navSys (planner) →
devSys-2 (build) → pilot (deploy).

---

## 0. North star — the keyboard IS the pluggable mobile UI surface

This is not "a QWERTY replacement." The reason we own the keyboard is that, on mobile,
**the keyboard footprint is the single largest, most-present UI surface in the app** —
and today Apple owns all of it. By suppressing the native keyboard (`inputmode="none"`)
we reclaim that whole slot and make it **ours and pluggable**:

- The bottom-mounted editor toolbar and the keyboard **become one surface**. The control
  strip lives in the keyboard's footprint, not stacked above it.
- That control surface is **registry-driven and swaps by context** — active plugin,
  note type / view, current selection. A voice note shows transport controls; a
  doc note shows format/`/`; a table shard shows cell controls; etc.
- This is the mobile home of `[[ui-view-driven-architecture]]` and
  `[[slash-palette-block-shard-architecture]]`. The Deploy-3 editor toolbar already
  exists as a **tool-descriptor registry** (one source, both surfaces render from it) —
  the keyboard consumes that same registry. The seam is already in the codebase.

**The model (Jim, 2026-06-22): a context-driven surface, not "keys + a slot."** The
footprint is ONE persistent surface that owns the bottom of the screen; **its entire
contents are a pure function of the active context** (selection type / block type / active
plugin / note type). The keypad is just *one occupant* of that surface — the control-set
for the default "caret-in-text" context — and for some contexts **there are no keys at all**:
- **no field active / browsing notes → navigation controls (search, new note)** — i.e. the
  current universal bottom nav, ABSORBED into this surface (Jim, 2026-06-23)
- caret in text → keypad + minimal format strip
- table cell selected → row/cell controls (no bold/strike — irrelevant there)
- splice/diagram block → diagram shortcuts
- image block selected → resize/crop/align controls, **keypad hidden entirely**

The bottom of the screen is therefore **always this one surface** — the standalone universal
bottom nav bar goes away, replaced by the surface's "no-field/navigation" context.

**Escalated (Jim, emphatic, 2026-06-23):** the conditional "hide nav while kb-active, return on
blur" is intolerable — every keyboard drop flashes the nav back under his thumb. So:
- **Immediate:** in custom-keyboard mode (toggle ON) the standalone bottom nav is **killed
  permanently** — never returns, no flicker (scope strictly to custom mode; default mode keeps
  its nav). Ships with the space + keyboard-drop fixes. Temporarily strands search/new-note in
  custom mode (Jim accepts).
- **Next slice — now TOP priority, ahead of Phase 2:** the nav-absorption — search + new-note
  become the surface's "no field focused" context — so the killed controls get their proper home
  inside the one surface. First concrete non-text context, proving the model.

There is never a "keyboard vs toolbar" question — it's one surface, many modes. The trigger
is already in the editor: ProseMirror distinguishes a `TextSelection` (caret in text) from a
`NodeSelection` (a block selected), so the surface just subscribes to selection/context and
renders the matching layout from the registry. "That's the power of rolling our own" (Jim).

**Cross-platform: one registry, many surfaces (Jim, 2026-06-22).** The same context-driven
control system is **app-wide and cross-platform**, not mobile-only. Desktop doesn't need the
keypad (there's a real keyboard), but it needs the *block-aware controls* just as much — so the
surface generalizes to **one control registry × multiple render targets**:
- **mobile** render target = the keyboard footprint (control strip **+** keypad-as-text-context)
- **desktop** render target = a toolbar (control strip, **no keypad**)

This becomes deltos's **one true app-wide toolbar** — context-scoped, with views that adapt to
screen size and available functionality — and is positioned to **wholesale replace the current
desktop rich-text toolbar at the top of the note editor** (the Deploy-3 `EditorToolbar`). That
toolbar is *already* registry-driven (Deploy-3 built desktop + mobile from one tool-descriptor
registry), so this is a **convergence, not a rewrite**: extend that registry from format-tools to
context-scoped app-wide controls, and let each surface render the context-appropriate slice. The
keypad is just the one occupant that exists only on the mobile surface.

**Build implication (applies from Phase 1):** model the footprint as a **context-driven
surface** whose contents come from a registry keyed by context. The keypad is the registered
layout for the default text context — NOT a permanent base with a slot bolted on (an
image-selected context must be able to replace the whole surface and hide the keys). Phase 1
ships only the text-context layout (keypad + minimal/empty strip), but the surface must be
**selection-aware** so adding contexts later is additive, never a rewrite. Do NOT hardcode the
keypad as always-present.

Honest framing (Jim, 2026-06-22): "It's a lot of work to build this keyboard, but it
might be an unlock for a better mobile UX than any Notes app out there." Treat it as a
flagship multi-phase surface, not a one-off widget.

## 0.5 Name = "Deck", and built as an extractable framework (Jim, 2026-06-23)

**Name: the surface is the "Deck."** A deck is a surface of controls that reconfigures for the task —
no keyboard baggage. The keypad is just ONE deck mode. Rename across the code: `KeyboardSurface`→`Deck`,
`deriveKeyboardContext`→`deriveDeckContext`, `KEYBOARD_LAYOUTS`→`DECK_LAYOUTS`, the surface CSS/classes
`kb-*`/`.kb`→`deck-*`/`.deck`; KEEP keyboard/keypad naming for the actual KEYS sub-component (the keypad is
a deck module, not the deck itself). (Spec file may be renamed deck.md later; kept as custom-keyboard.md for
now to avoid breaking in-flight references.)

**Build it decoupled, for eventual extraction as a standalone framework.** Jim's ambition: if the Deck gets
good, lift it into a standalone framework addable to any sufficiently advanced web app, reused across projects.
That cross-project reuse is what would justify the hard investments (predictive key-targeting, advanced
tap-sizing) — they become amortized framework capabilities, not one-app polish. So architect for extraction
NOW, even while it lives in-repo:
- **One-way dependency:** deltos depends on the Deck; the **Deck NEVER imports deltos app internals.** This
  single rule makes later extraction mechanical.
- **Host/editor coupling behind an ADAPTER:** Deck core is editor-agnostic (knows abstract "contexts" +
  "layouts"). deltos injects, via a thin adapter: (a) a context provider (PM selection/editor state → Deck
  context key), (b) the control/layout registry (concrete controls + what each DOES — key→editor transaction,
  nav→deltos route), (c) device info. All ProseMirror-specific code lives in the deltos adapter, NOT in Deck.
- **Self-contained module + its own settings/config**, fenced behind a clean public API (`index.ts`).
- **Stay in-repo for now** ("somewhat separate") — clean fenced module (own folder, promotable to
  `packages/deck/`); do NOT over-engineer into a published package prematurely. Boundary clean from day one.

**Vocabulary (Jim, 2026-06-23):** DECK = the surface. **LOADOUT** = a named set of controls/features the Deck
shows at a given time; the Deck displays exactly ONE active loadout (term beats "layout", which collides with
CSS layout). CONTEXT = the derived situation (selection/device) that selects the active loadout (registry maps
context→loadout). Named loadouts: **editor loadout** (today: keypad; later: keypad + format/slash), **nav
loadout** (search/new-note on the no-field context), future image/table/diagram/plugin loadouts.

**Agreed module structure (devSys-2 proposed, navSys confirmed 2026-06-23):**
- `src/deck/` — fenced folder, NOT a workspace package yet (promotable). Deck core imports NOTHING from deltos.
  - `index.ts` (public API) · `Deck.tsx` (surface: renders the registered loadout for the active context;
    registry + context as PROPS — no global registry) · `loadouts/Keypad.tsx` (the EDITOR loadout —
    editor-agnostic keypad; emits abstract KeyActions) · `types.ts` (DeckContext = opaque string, DeckLoadoutProps,
    DeckLoadoutRegistry = context→loadout, KeyActions = {insert(char), backspace(), enter(), …grows}) · `deck.css`
    (co-located; consumes HOST-supplied theme-token CSS vars — the theming contract; pins system-ui label font
    as a Deck invariant).
- `src/editor/deckAdapter.ts` (deltos side) — ALL PM-specific code: `deriveDeckContext(EditorState)→context`,
  the deltos registry (text→Keypad wired to PM KeyActions; navigation→search/new-note routes [slice B]), device
  info (useIsDesktop). ProseMirrorEditor builds registry + context and mounts `<Deck context layouts/>`.
- Registry = PROP-injected (forward-compatible with future plugin/shard dynamic registration: host composes the
  registry from the plugin set, passes as prop; a dynamic register() can layer on later if needed).
- **Slice A** = rename + decouple + adapter + keypad-emits-KeyActions, ZERO behavior change, full suite green
  (the green run is the boundary proof). **Slice B** = nav-absorption (first new context via the adapter).

## 0.6 The Deck layer model (Jim, 2026-06-23) — core structure

**NOT hardcoded top/middle/bottom slots.** The Deck is a **positional LAYER STACK** — an ordered set of
regions addressed by position (z-index-like), bottom-anchored. The ~47pt spacing is the KEYPAD-positioning
band: it travels WITH the keypad (keyboard-bearing loadouts) — NOT a universal always-present Deck base.
Loadouts without a keypad (e.g. nav) sit flush at the bottom (safe-area only), no 47pt band. A loadout
declares HOWEVER MANY regions it needs (1, 3, 5, …) and
places them by position; the keypad/submenu/selector are just layers a loadout places, not fixed slots. This
keeps it open for future plugin loadouts we can't predict (Jim — don't bake "3" into the contract).
- **Per-layer show/hide + collapse** is Deck-level behavior: hide a layer (e.g. the keypad) → layers above
  reflow down. Keypad hidden → its height frees up for the note view (the large-view-area win).
- Maps onto what's BUILT, zero rework: the ~47pt reserved slot = the **persistent base layer (position 0)**;
  the keypad = a layer above it; the on-demand submenu = a higher layer that grows upward.
- **Editor loadout v1** = simply the first loadout to use 3 positions: submenu layer · keypad layer · group-
  selector layer. Nothing stops a future loadout using 5, or floating an overlay layer over the keypad.
- **Emergent "restyle mode" (Jim):** lock the keyboard closed (long-press show/hide) → keypad layer collapses
  → the formatting layers stack into a slim bar + big view area. Falls out of layer-model + lock composing —
  text + formatting tools + room to see, no separate feature. Great for restyling without editing wording.
- Other loadouts use as few layers as they need (e.g. nav loadout = just the base/one layer). The layer stack +
  per-layer hide/collapse is Deck-level; loadouts just place layers.
- EXACT positional mechanics firm up when we build the editor loadout (first multi-layer loadout) — let real
  use shape it. Contract locked now: positional, extensible to N, persistent base; NOT fixed named slots.

---

## 1. Roadmap (locked with Jim 2026-06-22)

| Phase | Scope | Goal |
|---|---|---|
| **1** | Core QWERTY geometry-matched + basic typing (this doc §2) | Prove muscle-memory transfers — the make-or-break thesis. Get it in Jim's hands fast. |
| **2** | `123` + `#+=` layers · caps-lock · key-repeat everywhere | Complete, usable keyboard |
| **3** | Native feel: key-pop magnifier · **space-hold cursor trackpad** · double-space→period · long-press alternates | Match native feel |
| **4** | Fold toolbar / `/` palette / blocks into the reclaimed footprint as the **pluggable control surface** (the north star) | The actual unlock |
| later | SymSpell spellcheck (squiggles + tap-to-correct; doesn't need the strip) · emoji · voice | Decoupled, land anytime |

**EDITOR LOADOUT v1 — design locked (Jim, 2026-06-23), NOW THE NEXT BUILD (supersedes a standalone C-manual slice).**
Jim's call 2026-06-23: skip building keypad show/hide as its own slice — **the editor loadout v1 IS the next
build and it INCLUDES show/hide.** This is correct by construction: the always-present group-selector row (below
the keys) is the persistent editor chrome that survives when the keypad collapses, so the show/hide control
lives there. "Restyle mode" (lock closed → selector + submenu = slim bar + big view) then emerges for free.
This is the Phase-4 toolbar-fold, made concrete. The full editor loadout = keypad + the Deploy-3 grouped tools,
arranged keypad-aware (top→bottom):
```
  per-group submenu   (ABOVE the keys; appears when a group is selected)
  K E Y P A D                                                          (collapsible layer — show/hide)
  Style · Format · Lists · Insert  · [⌨ show/hide] [↶ ↷]    (top-level group selector; ALWAYS present, BELOW the keys; show/hide-keypad button + Undo/Redo right-aligned)
```
Show/hide spec (folded in here, see the KEYPAD SHOW/HIDE block below): the keypad is a collapsible layer; the
show/hide button rides the selector row (tap = toggle, long-press = lock w/ visual indicator); auto-show on
caret. Swipe-up auto-hide stays DEFERRED to a later polish slice. The selector row + show/hide button persist
when the keypad is hidden (the slim-bar / restyle-mode state).
- REUSES the Deploy-3 tool-descriptor registry (groups Style/Format/Lists/Insert + their controls already exist;
  image already omitted) — we ASSEMBLE keypad + that registry, not redesign the tools.
- Spatial layout INTENTIONALLY diverges from the static mock: the mock stacked selector + submenu BOTH above the
  keyboard (it couldn't touch the native keyboard); now we own the stack → selector BELOW the keys, submenu ABOVE.
  Take the TOOLS from the mock, NOT its stacking.
- Open details to pin at spec time (not blocking): Undo/Redo placement (likely the selector row, right-aligned);
  submenu hidden-by-default until a group is tapped (assumed yes — keys+selector at rest, submenu pops on demand).
- Still the EDITOR loadout (one Deck loadout); it grows from "keypad only" → "keypad + folded toolbar."

**KEYPAD SHOW/HIDE — design (Jim, 2026-06-23).** The keypad portion of the Deck shows/hides independently
(the Deck persists; the keys come and go). Build reliable-first, auto on top:
- **Manual button (build FIRST — the reliable floor):** a persistent show/hide-keyboard button in the bottom
  bar. Always present, always works — the override when auto fails; also fixes today's gap (no clean way to
  dismiss the keypad to read a note).
  - **Tap** = toggle shown/hidden.
  - **Long-press = LOCK the keypad in its current state** (Jim, 2026-06-23): suspends BOTH auto-show and
    auto-hide. Locked-shown won't auto-hide on swipe-up; locked-hidden won't auto-show on caret/tap. While
    locked you're fully manual — tap still flips it, it just won't move on its own. Long-press again = unlock,
    auto resumes. Needs a visual LOCK indicator on the button (auto vs pinned). Model: "tap drives; long-press
    decides whether the keyboard may drive itself."
- **Auto-show:** caret becomes active in the note body (tap-in / editor focus) → keypad shows.
- **Auto-hide:** a FAST, LARGE swipe-up → keypad hides. The "fast+large" thresholds (velocity + distance)
  distinguish it from a normal scroll — this is the tunable long-tail where "matches native feel" is won.
  (Native usually dismisses on downward drag/scroll; Jim's swipe-up = "done typing, let me read" maps to
  scroll-to-dismiss. Build Jim's; threshold tuning is the whole game.)
- **When keypad hidden, still in a note:** Deck collapses to the slim bottom bar (controls + show-kbd button),
  reclaiming the keypad space for the note; keyboard a tap/caret away. (navSys lean.)
- SEQUENCING (Jim CONFIRMED 2026-06-23): show/hide is NOT a standalone slice — it ships AS PART OF the editor
  loadout v1 (the selector row is its home). Manual button (tap-toggle + long-press-lock) + auto-show land
  with the loadout; swipe-up auto-hide is a later polish slice. QUEUE NOW: editor loadout v1 (incl. show/hide)
  → notebook drag-up → swipe-up auto-hide polish.

### Jim's scoping decisions (don't re-litigate)
- **Space-hold cursor trackpad** — Jim loves it. **Committed**; first feel feature after
  Phase 1. Mechanism is straightforward (own the space key → long-press → drive caret via
  selection API from finger delta); native's exact glide/acceleration is polish.
- **Backspace hold** — must **continuously delete AND accelerate like native** (char
  cadence speeds up; switch to word-delete on sustained hold). Core to feel → basic
  continuous+accelerating repeat is in **Phase 1**; word-delete + curve tuning in Phase 3.
- **Predictive suggestion strip** — **DROPPED** for good. Reclaiming that row is one of the
  wins of going custom (Jim: autocorrect is off; that real estate goes to our control surface).
- **Double-space → period** — nice-to-have, low priority (Phase 3).
- **Long-press accents** — Jim rarely uses; **deferred** past V1 (mechanism may ride the
  long-press infra built for the trackpad / key-pop).
- **Emoji** — nice-to-have, **not V1**.
- **Voice** — Jim wants to **research first**; kept as its own research-gated plugin, fully
  **decoupled** (server-side Whisper via the existing CF Worker), lands whenever.
- **Spellcheck** — still wanted (Jim's a self-described bad speller); lives as underline
  squiggles + tap-to-correct, so dropping the strip doesn't kill it.

---

## 2. Phase 1 — geometry-matched core QWERTY

**Goal:** a functional core keyboard, rendered pixel-matched to Jim's native iOS keyboard,
wired into the **real** mobile note editor, so Jim can feel-test whether his typing muscle
memory transfers. This validates the whole bet before we build feel/layers/plugins on top.

### 2.1 The geometry is the spec — match the reference exactly
Reference screenshot: **`docs/design/native-keyboard-iphone15plus.png`** (Jim's own device,
his native keyboard, portrait). **The screenshot is the source of truth.** Match it
pixel-for-pixel — keys a few px off corrupt muscle memory (Jim's hard requirement). Tractable
because user = Jim only (`[[build-for-the-actual-user]]`): match HIS device, not all iPhones.

- Device: **iPhone 15 Plus**, portrait, **@3x** → screenshot **1290 × 2796 px = 430 × 932 pt**.
  Divide screenshot px by 3 for CSS pt.
- **Measured first-pass grid** (from the screenshot; refine against the pixels, verify by
  overlay — see §2.4). All values in CSS pt:

  | element | value (pt) | notes |
  |---|---|---|
  | key pitch (horiz) | ~42.7 | ~128px; consistent across rows |
  | key width | ~37 | pitch minus ~6 gap |
  | key gap (horiz) | ~6 | |
  | key height | ~43 | |
  | row pitch (vert) | ~55 | ~165px |
  | corner radius | ~8 | eyeball; confirm |
  | side margin | ~3 | row 1 reaches near full width |
  | row 1 (QWERTYUIOP) | 10 keys, full width | centers ≈ 23,65,108,150,193,235,278,320,362,405 |
  | row 2 (ASDFGHJKL) | 9 keys, **½-key inset** (~22 each side) | |
  | row 3 | **shift** (~50 wide) + Z X C V B N M + **delete** (~50 wide) | letters align under row 2 |
  | row 4 | `123` + **space** (wide) + `return` | drop the 🌐/🎤 row entirely |

  (These are anchors so the build doesn't start cold; the **screenshot governs** and the
  overlay diff in §2.4 is the gate.)

### 2.2 Functional keys (Phase 1)
Every editing key is explicit — once `inputmode=none` suppresses the native keyboard, **nothing
comes free from the OS** (probe #68 finding). Each press dispatches a ProseMirror transaction
into the real editor.

- **Letters A–Z** — insert char.
- **Shift** — one-shot: capitalizes next letter, then auto-releases. (Caps-lock = Phase 2.)
- **Space** — insert `" "`. **Must render correctly:** the real editor loads ProseMirror's
  `white-space: pre-wrap` (the throwaway probe did not — that's why the probe collapsed
  runs of spaces and dropped a trailing space's caret advance). **Acceptance:** multiple
  spaces stack; caret visibly advances on every space including a trailing one.
- **Backspace** — tap = delete one char (own the mid-block delete + block-start join, per
  probe finding; `baseKeymap.Backspace` only joins at block boundaries). **Hold = continuous,
  accelerating delete** (char-by-char, cadence speeds up; native curve, tunable). Word-delete
  on sustained hold may be Phase 3, but continuous accelerating char-delete ships in Phase 1.
- **Return** — newline / block split (the editor's Enter behavior).

### 2.3 Integration & architecture (Phase 1)
- `inputmode="none"` set on the editor's contenteditable at view creation (before focus),
  `autocorrect=off`, `autocapitalize=off` (proven in the probe).
- Keys fire on **pointerdown + preventDefault** so the editor never blurs (proven in the probe).
- Wired into the **real mobile note editor** (not a throwaway route). Desktop unaffected
  (`useIsDesktop`); native keyboard suppression + custom keyboard are **mobile-only**.
- **Opt-in via a Settings toggle, DEFAULT OFF** — "Custom keyboard (experimental)",
  deviceState-persisted (works in the installed PWA). OFF = editor behaves exactly as today
  (native keyboard, no `inputmode=none`); ON = custom keyboard in the real editor. Rationale:
  Phase 1 has no numbers/symbols layer (Phase 2) and a URL-param escape is dead in the installed
  PWA (no address bar), so default-on would brick daily typing with no in-PWA way back. Jim
  flips ON to feel-test, OFF the instant he needs numbers/native. Revisit default-on after
  Phase 2. (Drop the `?kb` URL param — useless in the PWA.) Nice-to-have: an on-keyboard
  "switch to native" key at the iOS 🌐 globe position for one-tap mid-note fallback.
- **The toggle is PERMANENT, not test scaffolding (Jim, 2026-06-23).** It's a resilience valve:
  the whole feature rides on `inputmode=none` suppression, a WebKit behavior Apple can change in
  any Safari release. So the **native-keyboard path stays a fully-maintained, always-working mode
  forever** — `inputmode=none` is never unconditional/load-bearing. The toggle flips between two
  real supported modes, guaranteeing a working floor regardless of Safari changes. Even if custom
  becomes the eventual default, native stays one tap away permanently (just drop "experimental").
- **PARKED (not now — Jim, 2026-06-23):** because the control surface is decoupled from the
  keypad, the tool palette is usable in native-fallback mode too (same as desktop, no keypad) —
  it just needs a home above the native iOS keyboard. Defer designing that fallback-mode toolbar
  placement until it matters; don't pre-optimize. Goal now = make it work.
- **Context-driven surface (north-star, §0):** model the footprint as ONE selection-aware
  surface whose contents come from a registry keyed by context. The keypad is the registered
  layout for the **default text context** — NOT a permanent base. Phase 1 ships only the
  text-context layout, but the surface must already react to selection so other contexts
  (table-cell controls, image controls with the keypad HIDDEN, diagram shortcuts, plugin
  controls) drop in additively, never via a rewrite. Wire it to the editor's selection
  (`TextSelection` vs `NodeSelection`) as the context trigger.
- ~~The throwaway `/kbprobe` route + Settings→Developer entry (#68) can be removed once the
  real keyboard lands (separate cleanup).~~ DONE — `/kbprobe` route and Settings→Developer entry
  removed.

### 2.3a Visuals — theme color YES, theme font NO (Jim, 2026-06-23)
- **Inherit the active color theme.** The keyboard derives all its color from the active palette
  tokens (the 4 palettes × light/dark): surface bg, key bg, label, and accent all follow theme
  vars. A perk of owning the keyboard — it reads as part of deltos (palette-tinted, correct in
  light/dark), not a foreign iOS-grey element.
- **Do NOT inherit the app font.** Pin the key-label font to a stable system font
  (`system-ui`/SF — also the most native key look). The app has 4 selectable fonts; if labels used
  the active font, glyph metrics would shift per font and **disturb the pixel-matched key
  geometry** (the make-or-break requirement). Font is fixed; only color themes.

### 2.3b Tap targets — no dead zones (Jim's #1 usability issue, 2026-06-23)
Jim's verdict on the aligned build: looks great (better than native — themed), space fixed, but keys are
**noticeably harder to hit than native despite being the exact right size**. Root: our keyboard has **dead
zones between keys**; native has none. Native does two stacked things (confirmed):
1. **No dead zones (spatial):** every point resolves to the nearest key — the visible gaps are live hit area.
2. **Language-model targeting (predictive):** iOS dynamically resizes the *invisible* hit zones by what you're
   likely to type next (after "th", the "e" target grows). Visible keys never move. This is tied to the
   autocorrect/prediction stack — which **Jim has OFF**, so it likely contributes little for him.

**FIX (now — nearest-key, Jim's call):** touch targets become cells that **tile edge-to-edge (zero
inter-key gap)**; the **visible key renders smaller, centered inside its cell** at the already-matched
geometry. Visuals unchanged (overlay match preserved); only the invisible hit area grows to fill the gaps.
Irregular rows (shift/delete/space/123) fill to the row edges too. This is native's mechanism #1 and likely
most of Jim's gap given autocorrect-off.
**DEFERRED:** mechanism #2 (language-model-weighted dynamic targeting) — a separate, harder layer tied to the
future prediction/SymSpell engine; low value under autocorrect-off. Do zero-dead-zones first, feel-test, then
decide.
**EVAL CAVEAT (Jim, 2026-06-23):** judge tap accuracy over DAYS of real dogfooding, not a snap test. Two
things converge: the keyboard improves (dead zones gone) AND Jim's own accuracy improves as he stops leaning
on iOS auto-sizing (which trained slight sloppiness). No native-muscle-memory risk: geometry matches native
exactly, so retraining to tap more precisely only helps and transfers back to native fine. Verdict on whether
mechanism #2 is ever needed comes AFTER adaptation, not day one.

### 2.3c Vertical position — Deck bottom spacer (Jim, 2026-06-23)
Key SIZE was matched but key POSITION was not: native pads its keys UP with the bottom emoji/mic utility row,
which we dropped → our keypad sat ~47pt too LOW. Muscle memory is vertical too. Measured (IMG_6479): native's
bottom key row BOTTOM = 851pt, i.e. **81pt above the 932pt screen bottom** = dropped utility band (~47pt) +
home-indicator safe area (~34pt). FIX: a **~47pt bottom spacer at the DECK level** (below the loadout content,
above the safe-area pad), regardless of loadout (consistent bottom anchor). Target: bottom key row's bottom
sits ~81pt above the screen bottom. Verify by overlay — row centers at 932pt viewport: row1 ~662pt, row2
~717pt, row3 ~773pt, row4 ~829pt.

**CORRECTION (Jim, 2026-06-23): the 47pt slot is KEYPAD-positioning, NOT a universal Deck base.** It applies
ONLY when the keypad is shown (it's the band native reserves below the keys to put them at native Y). Loadouts
WITHOUT a keypad (e.g. the nav loadout) must NOT carry it — they sit FLUSH at the bottom (safe-area pad only).
navSys's earlier "Deck-wide regardless of loadout / consistent anchor" call was wrong (it floated the nav
loadout 47pt up with a gap below). In layer-model terms the base-spacing layer travels WITH the keypad, it is
NOT always-present. (Superseded the "always-reserved" framing below.)

**The spacer is a SLOT when the keypad is present (Jim, 2026-06-23):** the reclaimed ~47pt band is a reserved
slot BELOW THE KEYS that a keyboard-bearing loadout MAY fill (the editor loadout's group selector lives here)
or leave empty (renders as native-matching spacing). We pay for the space once (vertical match) and get a free control
home. INVARIANT: the band is always reserved at constant height → the KEYS NEVER MOVE whether the slot is
filled or empty (plain keypad ≡ keypad+selector in key Y-positions). Do NOT make the band appear only with the
editor loadout (that would shift keys). Reserve always, fill conditionally. (The editor loadout's on-demand
submenu is the SEPARATE strip ABOVE the keys — it grows the Deck upward into the note, also never pushing keys
down. Keys are stable in every state.)

### 2.4 Acceptance / gate
1. **Geometry overlay (navSys gate):** headless render of the custom keyboard overlaid on
   `native-keyboard-iphone15plus.png` at 430pt width — key centers/sizes/rows/margins match
   within a tight tolerance. navSys runs this before deploy (same discipline as the UI-refresh
   render-diffs).
2. **Space correctness:** multiple spaces stack; caret advances on every space incl. trailing.
3. **Backspace hold:** continuous, accelerating delete.
4. Unit/render tests green; tsc + eslint clean; no load-feel regression
   (`[[performance-is-a-standing-value]]`).
5. **Live feel-test (Jim, the real gate):** on deltos.blackgate.studio in the installed PWA —
   does typing feel native / does muscle memory transfer? Yes → build Phase 2+. No → rethink.

### 2.5 Deploy
ui-refresh worktree → devSys-2 lands → hand SHA to pilot → ff mainline + deploy worker+PWA →
verify live bundle hash flipped. Editor-modifying slices deploy unattended (only NEW
auth-bypass routes trip the classifier). prod-D1 not involved.

---

## 3. Phase 2a — number & symbol layers (Jim, 2026-06-23) — PARALLEL BUILD

Jim wants a SECOND dev (devSys) building the `123` number layer + `#+=` symbol layer in PARALLEL with
devSys-2's editor-loadout commit 2. Clean file split: this work is almost entirely `Keypad.tsx` (layout
data + active-layer state + the layer-switch keys); the editor loadout is `KeypadLoadout.tsx` + host wiring.
deck.css is the one shared file — coordinate edits via the coord lock, keep additions in separate sections.

**Reference screenshots (native iPhone 15 Plus @3x = 430×932pt, ÷3 — geometry is the spec, match exactly):**
- `docs/design/native-keyboard-numbers-iphone15plus.png` — the `123` number layer
- `docs/design/native-keyboard-symbols-iphone15plus.png` — the `#+=` symbol layer

**Layouts (transcribed; verify widths by overlay-diff against the screenshots — punctuation keys in row 3 are
WIDER than letter keys):**

`123` number layer:
```
1 2 3 4 5 6 7 8 9 0                  (10 keys, full width — same grid as QWERTY row 1)
- / : ; ( ) $ & @ "                  (10 keys, full width — note: 10, not QWERTY-row-2's 9)
#+=   .  ,  ?  !  '   ⌫              (switch[fn-width] + 5 wide punctuation + delete[fn-width])
ABC   [ space ]   →                  (mode key + space + return — same geometry as QWERTY row 4)
```

`#+=` symbol layer:
```
[ ] { } # % ^ * + =                  (10 keys, full width)
_ \ | ~ < > € £ ¥ •                  (10 keys, full width)
123   .  ,  ?  !  '   ⌫              (switch back to numbers + the SAME 5 punctuation + delete)
ABC   [ space ]   →                  (same row 4)
```

**Layer-switch wiring (the state machine):**
- QWERTY layer: the `123` key (row 4, currently the inert Phase-1 stub at Keypad.tsx:97) → number layer.
- number layer: `#+=` → symbol layer; `ABC` → QWERTY.
- symbol layer: `123` → number layer; `ABC` → QWERTY.
- Row 3 middle punctuation (`. , ? ! '`) and row 4 (`ABC` · space · `→`) are SHARED between number & symbol.

**Build notes:**
- Model the layouts as DATA (active layer = 'letters' | 'numbers' | 'symbols'; layout defs + switch keys) —
  a small refactor of the current hardcoded ROW1/2/3 arrays. Keep the editor-agnostic KeyActions contract
  (insert/backspace/enter) unchanged — every symbol just calls actions.insert(char). No new host coupling.
- Shift only applies to the letters layer; number/symbol layers have no shift (the switch key sits where
  shift was). Returning to ABC resets to lowercase (shift one-shot semantics unchanged).
- SCOPE = the two layers + switching ONLY. caps-lock and broader key-repeat (rest of Phase 2) are a
  separate follow-up — not in this dispatch.
- Geometry: reuse the existing deck.css key metrics/vars; rows 1&2 are 10 full-width cells; match row-3
  punctuation widths + the switch/delete fn-key widths to the screenshots. navSys overlay-verifies before deploy.

---

## 4. Global nav — top-right 3-dot menu → full-screen overlay (Jim, 2026-06-23)

**Why:** custom-keyboard mode (`body.deck-custom`) hides BottomNav entirely, so the full menu (notebook
switcher / trash / settings) is unreachable in custom mode — the known nav gap. Jim's fix: a GLOBAL top-right
3-dot (kebab) menu that opens a full-screen overlay hosting the existing nav. "Full-screen overlay at the
moment" = build the full-screen form now, structured so it can later become a sheet/partial without a rewrite.

**Scope decision (navSys, stated assumption — Jim correct me):** MOBILE-ONLY (desktop's ThreeRegionShell
already shows NavContent in a persistent left pane — no top-bar menu needed). Shown ALWAYS on mobile (both
normal and custom mode) as the consistent global affordance. In normal mode it coexists with BottomNav for now
(both reach the same NavContent); potential future consolidation = retire BottomNav's full-menu once the 3-dot
proves out, NOT in this slice. In custom mode it's the ONLY full-menu access (the gap-fill).

**Build (reuse, don't rebuild):**
- ICON: `Ellipsis` already exists — `import { Ellipsis } from '../icons'` (`<Ellipsis size={24} />`).
- BUTTON: mount in the mobile shell's `.shell__bar-end` (App.tsx ~310-315), top-right. `overlayOpen` state in
  `AuthedShell()`.
- OVERLAY: new `FullScreenNav` component mirroring the `DrawerNav` pattern (scrim + fixed panel + `inert`/
  `aria-hidden` when closed + `role="dialog"`), but full-screen (inset:0). Render `<NavContent onNavigate={() =>
  setOverlayOpen(false)} />` inside — NavContent is already standalone-reusable (takes only `onNavigate`); it
  auto-closes the overlay on any nav.
- CRITICAL: the overlay + its button MUST remain visible/usable when `body.deck-custom` is active (unlike
  BottomNav which is hidden in that mode) — this is the whole point. z-index above DrawerNav (>200).
- a11y + theme: reuse DrawerNav's inert/scrim approach + the app theme tokens; ≥16px touch targets.

**File ownership (3rd parallel stream — clean of the two Deck builds):** App.tsx + new FullScreenNav.tsx +
styles.css. The Deck builds own Keypad.tsx / KeypadLoadout.tsx + host. styles.css + App.tsx are coord-lock
shared with devSys-2's host wiring — take the lock, keep additions sectioned, release promptly.

---

## 5. Local spellcheck — ships with Deck, toggle (Jim, 2026-06-23) — BUILD NOW

Hybrid spellcheck, part 1. **Local SymSpell, ships with Deck, ON by default, settings toggle to disable.**
Offline, instant, free — good for a bad speller (Jim). Live squiggles + tap-to-correct.

**🌐 ONE UNIFIED SYSTEM, APP-WIDE (Jim, 2026-06-23):** the Deck/deltos spellcheck REPLACES native browser
spellcheck EVERYWHERE — desktop browser AND mobile (custom-keyboard mode AND native-keyboard fallback). NOT
mobile-only. Requirements: (1) the engine + decorations run wherever the editor mounts (verify NOT gated to
custom-keyboard/mobile); (2) SUPPRESS native browser spellcheck — set spellcheck="false" on the ProseMirror
editable so there's never a competing set of squiggles/suggestions; ours is canonical. (3) ours-or-nothing: the
Spellcheck toggle controls OUR squiggles; native stays suppressed even when ours is off (off = no spellcheck,
NOT a native fallback — "one unified system"; navSys lean, easy to flip if Jim wants native-when-off). (4)
suggestion PRESENTATION is platform-adaptive (one engine, many render targets — the Deck north star): Deck
top-slot bar on mobile-custom (§5.1), popover on desktop / native-kbd. Engine + squiggles + custom dict (§5.2)
are unified across all targets.

**Architecture (respect the Deck extraction boundary):**
- ENGINE in Deck-core (editor-agnostic): SymSpell index over a trimmed English frequency dictionary, built in a
  Web Worker, lazy-loaded (~80-190KB deferred — holds [[performance-is-a-standing-value]]). Public API:
  lookup(word) → ranked suggestions; check(text) → misspelled ranges. No editor/PM types in core.
- EDITOR INTEGRATION (deltos-side, via the adapter): ProseMirror decorations underline misspelled words
  (squiggle); tap a squiggled word → popover with top suggestions → tap to replace (one txn). Debounce /
  check changed+visible text only, NOT per-keystroke. Title node + code_block excluded (no spellcheck in mono).
- SETTINGS: a "Spellcheck" toggle, deviceState-persisted (same pattern as the custom-keyboard toggle),
  DEFAULT ON. Disable = no squiggles, engine not loaded.
- v1 scope: suggestions + tap-to-correct + a simple "ignore/add word" (local custom-word list) is NICE-TO-HAVE,
  not required. No grammar (that's the LLM add-on, §6/later). Build-for-Jim: skip locale/multi-language.
- Lib: SymSpell JS impl (or hand-port the core) + a frequency dict (e.g. a trimmed en_50k); Typo.js = fallback.
- ACCEPTANCE: type a misspelling → squiggle appears (debounced); tap → suggestions → replace works; toggle off
  → squiggles gone + engine unloaded; no typing-latency regression (engine off the main thread); tests for
  lookup ranking + the decoration/replace seam.
- OWNER: devSys-2 (editor + Deck lane).

### 5.1 Suggestion UI → Deck TOP SLOT word bar (Jim, 2026-06-23 — first impression "at least as good as native")
Refinement to slice 3: replace the anchored popup suggestion menu with a **horizontal scrolling word bar in the
Deck's TOP SLOT** (the submenu-layer position) — like the native iOS suggestion/predictive bar.
- TRIGGER: tap a squiggled (misspelled) word → the top slot shows ranked suggestions (engine lookup(word)) as
  a horizontally SCROLLABLE list (pills/words, themed, ≥16px/thumb-sized tap targets).
- ACTION: tap a suggestion → replace the word (reuse slice 3's one-txn replace seam) → bar dismisses, top slot
  returns to default. Dismiss on tap-elsewhere / re-tap.
- ARCHITECTURE (the payoff): the top-slot layer is now a CONTEXT-DRIVEN surface with MUTUALLY-EXCLUSIVE
  occupants — formatting submenu · spellcheck suggestion bar · (voice) waveform (§6.1). Build the suggestion
  bar as ONE occupant of that shared layer, NOT a bespoke overlay → it sets up the same top-slot occupant infra
  the voice waveform reuses. This is the Deck "one surface, many modes" north star concretely.
- SCOPE: Deck/custom mode (has a top slot). Non-Deck (desktop / native-keyboard mode) keeps the popover as the
  fallback (no Deck top slot there) — or simplest acceptable; Jim's experience is the Deck path.
- Reuse the engine lookup + replace seam; this only relocates the PRESENTATION (popover → top-slot bar).
- OWNER: devSys-2. Build NOW (Jim's actively feel-testing spellcheck); establishes the top-slot occupant
  pattern BEFORE the mic-UI waveform slice.

### 5.2 Per-user custom dictionary — account-synced, view/edit (Jim, 2026-06-23)
Jim: add a per-user dictionary; the suggestion bar's last item = a `[+ Add to dictionary]` action; PLUS a way
to VIEW + EDIT it. Decided: **ACCOUNT-SYNCED** (follows the user across devices).
- **ENGINE (Deck-core, generic):** accept a CUSTOM ALLOW-LIST alongside the base 50k dict — a word is
  misspelled only if it's in NEITHER. Small public-API extension (custom word set, consulted in checkText);
  re-check on change. Stays zero-deltos-coupling (any embedding app can supply a custom list). LATER nicety:
  index custom words so they're SUGGESTED for near-typos ("deltso"→"deltos").
- **STORAGE (deltos, account-synced):** a small synced entity — per-row (word, accountId, syncSeq, tombstone),
  mirroring the notebook/note sync model (set semantics → conflict-free add/remove). Rides the EXISTING
  account-scoped sync engine. 🚨 ACCOUNT-ISOLATED is a HARD requirement, BOTH server (query scope by accountId)
  AND client (store partitioned / cleared on account switch) — same class as [[client-account-isolation-gap]]
  (#52). secSys reviews isolation. D1 migration → --remote apply routed to Jim's terminal
  ([[wrangler-d1-prod-route-to-user]]).
- **ADD action:** `[+ Add to dictionary]` = the trailing, visually-distinct action item in the §5.1 suggestion
  bar → addWord(flagged word) → squiggle clears immediately + syncs. (Design the §5.1 bar with room for a
  trailing action so this is zero-rework.)
- **VIEW/EDIT:** a Settings management surface — list all custom words, remove (tombstone), optionally add
  manually. Account-scoped.
- **BOUNDARY:** engine allow-list = Deck-core (generic); storage + sync + add-action + manage-UI = deltos
  (injects the custom list into the engine, owns the data + UI). Same pattern as the transcriber injection.
- **OWNERS:** backend synced entity + client sync store = devSys (backend lane; can START NOW in parallel —
  independent of the in-flight §5.1 bar). Engine-consumption + add-action + manage-UI = devSys-2 (AFTER the
  §5.1 bar + once devSys's client store API exists: list/add/remove). secSys = account-isolation review.
- SEQUENCING: §5.1 bar (in flight) → devSys backend synced entity (start now) → devSys-2 engine+add+manage-UI.

## 6. Voice-to-text plumbing — decoupled pipeline (Jim, 2026-06-23) — BUILD NOW (mic-key UX DEFERRED)

Hybrid spellcheck part 2's sibling. Build the PLUMBING now; the **exact mic-key behavior in the Deck is an
OPEN design question (Jim) — do NOT wire a mic key yet.** Architect for the future VOICE MEMO note type.

**3 decoupled stages — transcript is a FIRST-CLASS artifact, NOT hardwired to insert-at-caret:**
1. CAPTURE — mic → audio blob (MediaRecorder), note-agnostic client module.
2. TRANSCRIBE — POST audio → NEW Worker route /api/transcribe → Cloudflare **Workers AI Whisper**
   (@cf/openai/whisper-large-v3-turbo) → returns { transcript, audio }. Add the AI binding to the existing
   Worker. Auth via the existing bearer/session. (Use the cloudflare / wrangler / agents-sdk skills.)
3. CONSUME — caller's choice. v1 consumer = DICTATION (insert transcript at caret, discard audio) but DO NOT
   couple the service to that — expose transcribe() returning the transcript + audio so a future VOICE MEMO
   consumer can KEEP the audio (→ Cloudflare R2) + store the transcript as note content (→ existing search
   index = searchable). Renders later via the view-driven note-type system.

**Scope NOW:** stages 1+2 + a transcribe() service with a clean API, end-to-end testable WITHOUT a Deck mic key
(a temp dev trigger / test harness is fine — like the #68 probe). NO mic-key UI, NO R2/memo persistence yet.
**OPEN (navSys+Jim design before wiring the key):** mic-key interaction (tap-toggle record vs hold-to-talk),
placement in the Deck (keypad fn-row vs editor-loadout control), recording + transcribing feedback states.
**Shared plumbing:** the Workers AI binding stood up here is reused by the advanced-LLM-spellcheck add-on (§ later).
**SYNERGY:** audio→R2 blob store + blob-ref sync = the same substrate the attachment/file shard needs.
- OWNER: devSys (server/Worker + client service lane — clean of devSys-2's spellcheck files).

### 6.1 Mic-key placement + interaction + voice-mode UI (Jim, 2026-06-23)
**Make room in the editor-loadout selector row, then add the mic as a first-class control:**
- MERGE the **Lists** group INTO the **Insert/Plus (+)** group → one "+" group holding lists + the other
  inserts. Selector row goes from [Aa Style][B Format][☰ Lists][+ Insert] → [Aa Style][B Format][+ Plus],
  freeing a slot. (Undo/Redo + show/hide stay.)
- ADD a **Mic** control to the freed slot in the selector row (bottom of the dock), first-class.
  - Interaction (mirrors the show/hide tap/long-press grammar): **TAP = toggle** voice mode (record until
    tapped again / auto-stop on silence); **LONG-PRESS = hold-to-talk** (record while held, release →
    transcribe). Streaming is NOT available (Whisper is batch) — accepted; it collapses the live-text UI a bit.
- VOICE-MODE UI: while the mic is active, the **top slot above the keys (the submenu layer) becomes a
  FULL-WIDTH WAVEFORM** (Web Audio AnalyserNode → canvas) so it's unmistakable you're in voice mode. On stop →
  a brief "transcribing…" state → transcript inserts at caret.
- ✅ PREVIEW-UX LOCKED (Jim, 2026-06-23): TRANSCRIPT-MODE voice loadout — the keypad swaps out for the voice
  loadout (waveform top + scrolling transcript-preview pane in the footprint). Rough chunks stage in the pane;
  the FINAL full-context pass AUTO-COMMITS to the note at caret on stop (notes-app flow; pane is the during-
  recording surface only, no glance-first step). LATENCY MEASURED = ~1092ms round-trip (1s synthetic clip,
  worker 36bc7358) → not instant, so a "transcribing…" beat is needed + the §6.2 chunked preview is worth
  building for long dictation (preview trails speech ~1s vs one long end-wait). Real-speech/longer-clip latency
  TBD on-device once the mic UI exists.
- OWNER: devSys-2 (editor loadout / selector lane), AFTER spellcheck + AFTER devSys's transcribe() lands
  (the mic control consumes that service). Wires to devSys's transcribe(); no new pipeline.
- 🔒 SECURITY GATES (secSys ruling @c1210fc, REQUIRED before the mic ships — cheap, zero durable state):
  (a) TIGHTEN the per-call clip cap on the DICTATION path to dictation-proportionate (~60–120s / a few MB);
      keep the 25MB cap only for an explicit future chunked voice-memo path. Bounds worst-case paid-inference
      cost + worker memory. (The 25MB cap ≈ ~25 min of audio = a large paid call; an interactive mic invites
      accidental runaway — a retry loop or a forgotten/stuck recording.)
  (b) CLIENT single-flight + min inter-call interval — ONE transcribe in flight at a time, debounce rapid mic
      taps, so a UI bug can't loop the paid endpoint.
  (c) [LOW, fold in] precheck the Content-Length header and reject >MAX BEFORE c.req.arrayBuffer() buffers the
      full body into worker memory (today the 413 fires after buffering up to the ~100MB platform cap →
      memory-pressure amplifier near the 128MB worker budget). Tightening (a) also shrinks this.
- 🔒 DEFERRED, HARD-REQUIRED BEFORE >1 USER (secSys): a durable per-account rate-limit (KV/DO) + per-account
  transcribe-call accounting/observability. NOT needed at single-user dev scale; MANDATORY the moment this is
  exposed to any additional/real/public user. Record as a gate on the real-users flip (posture =
  [[pre-real-users-clean-state-bias]]). Same line as data-preservation: proportionate now, mandatory at scale.

### 6.1b Where the voice code lives — Deck vs deltos (Jim, 2026-06-23)
Jim's read: voice transcription shows INSIDE the Deck → it's a DECK feature, not a deltos one → it changes
where the code is stored. Correct. Resolution = the SAME adapter split as the keypad + spellcheck: UI +
capability in the Deck (extractable), backend + app-specifics injected by deltos. Keeps the one-way dep
([[custom-keyboard-direction]] §0.5: Deck never imports deltos).
- **INTO Deck-core (extractable):** the voice LOADOUT (mic key, tap=toggle/long-press=hold, waveform via Web
  Audio, scrolling transcript-preview pane, voice-mode state machine); AUDIO CAPTURE (the MediaRecorder
  wrapper — generic browser API, zero deltos coupling → devSys's audioCapture.ts RELOCATES here); a
  **Transcriber INTERFACE** the Deck calls but does NOT implement: transcribe(blob) → { transcript } (Deck
  never knows it's Whisper).
- **STAYS deltos (injected via the adapter/registry):** the CONCRETE transcriber (devSys's voiceTranscribe.ts
  = POST /api/transcribe + deltos bearer) = deltos's implementation of the Deck's Transcriber interface; the
  Worker route; the "commit final transcript to the note" action (PM insert, host-provided like every control).
- DEPENDENCY stays one-way: Deck defines the interface + UI; deltos implements + injects — same as the control
  registry + context provider. Any embedding app brings its own transcriber (CF Whisper / OpenAI / on-device).
- PAYOFF: voice becomes a built-in Deck capability (cross-project reuse — the point of extracting the Deck),
  and it's consistent with spellcheck (engine in Deck-core, editor integration injected). Rework is minimal:
  the plumbing devSys built is already decoupled, so transcribe() just BECOMES the injected impl; mostly
  relocating capture + defining the interface seam, folded into the mic-UI slice (§6.1).

### 6.2 Chunked live preview + final full-context pass (Jim's idea, 2026-06-23) — ADDITIVE LAYER, LATER
Goal: show words a few sentences at a time DURING recording (hide latency), then a FINAL pass over the WHOLE
recording for the most accurate, full-context transcript. **Feasible + good.** Two tiers:
- **Live PREVIEW (rough):** during recording, capture rolling chunks — ideally split on SILENCE via voice-
  activity detection so cuts land BETWEEN phrases, not mid-word — transcribe each chunk, append to a greyed
  "draft" preview. Gives the few-sentences-at-a-time feel.
- **FINAL pass (authoritative):** on stop, transcribe the FULL recording in ONE call → Whisper uses maximum
  context (it windows in 30s segments with carryover), so punctuation / homophones / boundaries are best →
  this REPLACES the preview. Exactly Jim's framing: preview = fast+rough, final = accurate-with-full-context.
- WHY it composes with no rework: the plumbing devSys is building now (single full-audio transcribe()) **IS
  the final pass** + the foundation. The preview is an ADDITIVE layer that reuses the same transcribe() on
  chunks. So devSys's transcribe() must stay CHUNK-AGNOSTIC (works on any Blob) — it already does.
- Caveats: chunk-boundary VAD is the hard part (mid-word cuts = errors; preview is intentionally draft-quality);
  cost = N chunk calls + 1 final (trivial single-user); final pass adds a "finalizing…" end beat.
- SEQUENCING: base pipeline (devSys, now) → mic key + waveform + insert-final-transcript (devSys-2, §6.1) →
  THEN the chunked-preview layer (after we measure real round-trip latency on the base path).

---

## 7. Keypad feel batch — the remaining native-parity gaps (Jim, 2026-06-23)
Jim's prioritized "main gaps once current work lands." Mostly the existing Phase 2/3 roadmap items, now ordered.
Lane = Keypad.tsx + keypad interaction (devSys, keypad author) — distinct from spellcheck/voice. Queue AFTER the
current arc (Jim's framing: "once the current work lands"); can start when a hand frees (devSys after custom-dict
backend). Match Jim's native iPhone 15 Plus behavior exactly (muscle memory).

1. **Double-space → period.** Two spaces in a row → replace the trailing space with ". " (period + space).
   Standard iOS. Pairs with #3 auto-cap (the new sentence then auto-capitalizes). Skip after punctuation /
   non-letter context. Easy.
2. **Key-pop on press.** Native magnified key "balloon" above the pressed key on pointerdown, gone on release.
   Letter keys only (native doesn't pop space/fn keys). CSS/DOM pop element at the matched key geometry; the
   long-tail is matching native's exact balloon shape. Visual polish, buildable.
3. **3-STATE shift + auto-capitalize** (replaces today's 2-state one-shot shift). Native model exactly:
   - States: (a) lowercase → (b) single-capitalize = one-shot (next letter caps, then back to lowercase) →
     (c) LOCKED uppercase (caps lock). DOUBLE-TAP shift = caps lock; tap from caps-lock = back to lowercase.
     Shift key shows the 3 states distinctly (like native).
   - AUTO-CAPITALIZE first letter of a sentence: at doc start, after a newline, and after ". "/"! "/"? " →
     auto-arm the one-shot capitalize. BOUNDARY NOTE: auto-cap depends on the PRECEDING text (editor state),
     which the editor-agnostic Deck keypad doesn't own → the deltos ADAPTER (knows PM caret context) computes
     "should auto-cap" and signals the keypad to arm its one-shot shift (keypad stays generic: it just has a
     shift state the host can arm). Keeps the Deck boundary clean.
4. **Long-press spacebar → cursor-placement trackpad (mimic native exactly, Jim 2026-06-23).** BUILDABLE.
   - GESTURE: long-press the spacebar → enter caret-placement mode → the **WHOLE keypad surface becomes the
     trackpad** (drag your finger anywhere across the keypad to move the caret, not just on the space key).
     Release → exit, back to typing.
   - VISUAL: the **keys REMAIN (the grid/shapes stay) but the LETTERS DISAPPEAR** (blank keys) — that's the
     native cue that you're in trackpad/caret-move mode. A CSS state on the keypad ("deck trackpad mode").
   - MOVEMENT: RELATIVE / delta-based like native — finger movement → proportional caret movement, 2D
     (horizontal = char-by-char, vertical = line-by-line). NOT absolute posAtCoords-jump; the caret tracks the
     drag direction/distance from the long-press origin.
   - BOUNDARY: keypad (Deck-core) enters trackpad mode + emits ABSTRACT caret-move intents (e.g. moveCaret
     dx/dy or directional steps) on pointermove; the deltos adapter maps them to PM selection moves. Keypad
     stays editor-agnostic (knows "trackpad mode + finger deltas," not PM).
   - CAN'T reproduce: the native HAPTIC tick (no iOS Safari Vibration API) — but Jim has haptics OFF, moot
     ([[custom-keyboard-direction]]). Matching native's exact glide ACCELERATION is polish, not a blocker.
   - Already COMMITTED + "Jim loves it" in the §1 Phase-3 roadmap. GREEN-LIGHT.

SEQUENCING within the batch (devSys to refine): 3-state-shift+auto-cap and double-space→period are the typing-
correctness wins (do first); key-pop + space-trackpad are the feel/polish wins (do after). All Keypad.tsx-local
except auto-cap's adapter signal. navSys overlay/behavior-verifies vs native before deploy.
