# Drag-to-reorder rebuild + Keep-Board masonry — perf & feasibility analysis

**Status:** analysis / decision doc (no code). **Author:** research crew, 2026-07-08.
**Scope:** how to rebuild drag-to-reorder for the fluid "lift + others reflow around it"
feel (list **and** Board), triggered by **long-press on the note body** (not a grip
handle), coexisting with the existing horizontal swipe; and whether the Keep Board can
do **order-correct masonry in pure CSS** on Jim's devices.

Target user: **Jim only**, primary device **iOS Safari** (iPhone), secondary a laptop
(Safari or Chrome). No multi-user/a11y/i18n taxes — we target his actual browsers.
North stars in play: **load-feel / anti-bloat** (nothing off-first-load bloats; reorder
+ masonry are off-track view concerns, must stay lazy) and the **SwipeRow house style**
(`packages/client/src/components/SwipeRow.tsx:2` — "No framer-motion or animation
library; driven by Pointer Events imperatively").

---

## 1. Summary — the two recommendations

- **Drag-reorder → HAND-ROLLED FLIP + Pointer Events** (the SwipeRow house style),
  reusing the existing `useDragAxis` lock machinery and the `noteSort`/`customOrderReorder`
  data layer verbatim. **0 kB added to the bundle.** dnd-kit (~13–15 kB gzip, and it
  can't natively give the "others flow around the lifted card" FLIP feel) and
  framer-motion `Reorder` (~30 kB gzip full lib; ~5 kB via `LazyMotion` but you fight
  its opinionated model) both lose on anti-bloat and on control of the exact feel.
- **Masonry → PURE-CSS `display: grid-lanes` with `flow-tolerance: infinite`** (the new
  settled "CSS Grid Lanes" syntax) — **it shipped in Safari 26.4 / iOS 26.4 stable
  (March 2026)**, which is Jim's primary browser, and `flow-tolerance: infinite`
  restores strict source/reading order (so pin-partition + sort order is preserved).
  Gate it behind `@supports (display: grid-lanes)` with the **current uniform grid as
  the fallback** for the laptop if it's on Chrome/Firefox (still flagged there in 2026).
- **The `grid-template-rows: masonry` keyword is the WRONG/dead syntax** — caniuse shows
  it is *not* in stable Safari/iOS (Firefox-only, Chrome none). Use `display: grid-lanes`.
- **#1 and #3 share the same "measure rects" primitive but must not both own layout.**
  Solve it cleanly: masonry (grid-lanes) owns *resting* layout; the FLIP drag runs as a
  transform-only overlay on top and only writes an order key on drop — they compose, they
  don't fight. (Details in §4.) The one genuine risk is FLIP-in-a-masonry-grid: see §4.

---

## 2. Drag-reorder — approach comparison

### The target feel (what we're building)
Picking up a note **lifts it out of the flow** (raised, follows the finger); the **other
notes fluidly slide into the gap** it left and reflow live as you drag over new positions
(FLIP-style). Works in **both** the list (vertical) and the Board (2-D grid). Trigger =
**long-press anywhere on the note body**, and it must **disambiguate from the existing
horizontal swipe** on that same body (SwipeRow: left/right = delete/pin/move).

This is a real change from what's shipped: the current
`packages/client/src/lib/useCustomOrderDrag.ts:12` drives reorder from an explicit **grip
handle** (`⠿`, `App.tsx:407`) *specifically to avoid* fighting the swipe, and it only
moves a drop-line indicator — **no reflow animation, no lift**. Jim wants this rebuilt.

### Comparison table

| | **(1) dnd-kit** (`@dnd-kit/core` 6.3.1 + `/sortable` 10.0.0 + `/utilities` 3.2.2) | **(2) framer-motion `Reorder`** (`framer-motion` 12.x / `motion`) | **(3) Hand-rolled FLIP + Pointer Events** (SwipeRow style) |
|---|---|---|---|
| **Bundle (min+gzip)** | **~13–15 kB gzip** combined (core is the bulk; core alone ≈ 10 kB min / and reported ~18.9 kB *raw min*; sortable + utilities add several kB). Real number is fuzzy across trackers — treat as **~13–15 kB gzip, ~40 kB min**. Tree-shakes *some* but sensors/collision/measuring are pulled in for sortable. | **~30–32 kB gzip** for the full `framer-motion` (poor tree-shaking — "not modular, tightly coupled"). `LazyMotion` + `m` can cut the *initial* payload to **~4.6 kB**, but `Reorder` + layout animations pull the layout-projection feature set back in, and you inherit its layout-animation model. | **0 kB.** Uses only `useDragAxis` (already in the repo, `lib/useDragAxis.ts`) + `getBoundingClientRect` + `requestAnimationFrame` + WAAPI/transitions already used by SwipeRow. |
| **Lazy-loadable (off first-load)?** | Yes — dynamic-import only when a reorder-capable view mounts. But it's a *new* 13–15 kB chunk the SW must precache to keep warm loads instant (`plugins-lazy-past-first-paint` pattern). | Yes, same caveat, larger chunk. | Yes and trivially — it's just more code in the already-lazy Board/List path; **no new dependency, no new precache surface.** |
| **Runtime perf (mobile Safari, long list)** | Good — transform-based, but sortable recomputes rects/collisions on every move; on a long list the `SortableContext` measuring can cost. Its default drop animation is transform-only (compositor-friendly). | Good — layout-projection is transform-only and GPU-composited; but the projection engine does per-frame work and its "magic" can jank on large trees / during scroll. | **Best-controlled** — we write exactly the transforms, keep everything `translate`-only (compositor), animate with a single WAAPI/`transition` on `transform`. No library reflow tax; matches SwipeRow's proven imperative path (`SwipeRow.tsx:80` `applyDx`). |
| **Long-press + swipe disambiguation** | dnd-kit **supports it natively**: `PointerSensor` `activationConstraint: { delay: 250, tolerance: 5 }` — hold ≥250 ms with <5 px motion arms the drag; move first = no drag (falls through to our swipe). This is the *right* primitive, and it's the one we'll replicate. But combining it with our own SwipeRow on the same element means two gesture systems contending for the same pointer stream. | `Reorder` uses press+drag with a `dragListener`/`onDragStart`; long-press-to-arm is **not first-class** — you'd bolt on a timer anyway, then hand off to its drag. Contends with SwipeRow the same way. | We own the pointer stream **already** via `useDragAxis`, which *already* axis-locks: horizontal-first → swipe, vertical/hold → we can route to reorder. Adding a **long-press timer that arms drag, cancelled by >8 px horizontal move** is a natural extension of the existing lock logic (§ FLIP sketch). One gesture system, one source of truth. |
| **Effort to build target feel** | Medium-high. Sortable gives you reorder + a drop animation, but the **"others fluidly reflow as you drag"** live feel needs its `animateLayoutChanges` tuning; the 2-D Board reflow and the long-press-vs-swipe handoff are custom regardless. You adopt its abstractions (DndContext/Sortable/sensors/modifiers) and bend them. | Medium-high. `Reorder.Group`/`Reorder.Item` is genuinely quick for a **1-D list** with automatic reflow — this is its sweet spot. But the **2-D Board** is not what `Reorder` does (it's axis-oriented), and the swipe handoff + long-press arming are still custom. | Medium. You write the FLIP loop yourself (measure → reorder → invert → play), but it's ~120–180 lines in the exact style the codebase already proves works, and it's the **same** mechanism for list and Board. No abstraction impedance. |
| **Fit with deltos values** | Weak on anti-bloat (new 13–15 kB dep + precache surface) and **directly contradicts** the SwipeRow "no animation library" house rule. | Weakest on anti-bloat (heaviest); `LazyMotion` mitigates but still a framework; also contradicts the house rule. | **Perfect fit** — it *is* the house style, zero bloat, reuses `useDragAxis` + the data layer, stays lazy with no new precache chunk. |

### Recommendation: **(3) Hand-rolled FLIP + Pointer Events.**

The deciding factors: **0 kB vs 13–30 kB gzip**, a hard-standing **"no animation library"
house rule** that SwipeRow already establishes for exactly this class of gesture, and the
fact that **none** of the libraries give the target "others fluidly reflow around the
lifted card in a 2-D board" for free — the Board reflow, the long-press arming, and the
swipe handoff are custom work under *every* option. If it's custom work anyway, do it in
the house style with no dependency. The FLIP primitive is small and well-understood, and
we already own the pointer-gesture and data layers.

Genuine counter-consideration (flagged honestly): dnd-kit is the "safe" industry default
and framer-motion `Reorder` is genuinely the fastest path *for a plain 1-D list*. If Jim
later wants many more DnD surfaces (cross-notebook drag, tree DnD, etc.), a shared dnd-kit
foundation could amortize. For **this** feature, on **these** devices, hand-rolled wins.

### The FLIP + long-press sketch (recommended build)

**FLIP loop** (First-Last-Invert-Play), run on every reorder step:
1. **First** — before changing order, measure each visible card's rect
   (`getBoundingClientRect()`), keyed by note id. Cheap; only visible rows.
2. **Reorder** — as the finger crosses a card's midpoint, compute the new index
   (reuse the exact hit-test in `useCustomOrderDrag.ts:53` `indexAtY`, generalized to
   `indexAt(x,y)` for the 2-D Board). Update a local `order` array → React re-renders the
   list in the new order. The **lifted** card is rendered in a raised layer following the
   finger (position: the pointer delta, `translate` only).
3. **Invert** — after the DOM reflows to the new order, measure each card's **new** rect,
   and for every card that moved, set `transform: translate(oldX-newX, oldY-newY)` with
   **no transition** — visually pinning it to where it just was.
4. **Play** — on the next frame, clear the transform with a `transition: transform
   ~180ms ease` (or a single WAAPI animation). Every displaced card **slides** from its
   old slot to its new slot. Transform-only → stays on the compositor → no layout jank.
   This is the "others fluidly flow around it" effect.

On **drop**: run one final FLIP to settle the lifted card into its slot, then persist with
the **existing** `reorderCustom(notes, from, to)` (`lib/customOrderReorder.ts:19`) — one
O(1) fractional-key write via `fractionalMidpoint` (`lib/noteSort.ts:94`). **The entire
data layer is kept as-is** (Jim: "the DATA layer is fine, keep it").

**Long-press arms it / horizontal move stays with SwipeRow** — extend the pointer-down
path (not a separate grip):
- `pointerdown` on the note body → start a **long-press timer (~250 ms)** *and* let
  `useDragAxis`'s existing 8 px lock logic run (`useDragAxis.ts:68`).
- If the finger moves **horizontally past the 8 px lock threshold before the timer
  fires** → it's a **swipe**; cancel the long-press timer, hand the gesture to SwipeRow
  exactly as today (delete/pin/move). This is the current axis-lock: `rawSecondary >=
  rawPrimary` abandons — we mirror it so "horizontal-first" = swipe.
- If the finger **stays within a small tolerance (~8–10 px) until the timer fires** →
  **arm reorder**: haptic/scale-up the card (lift), capture the pointer, and switch the
  active gesture to the FLIP loop. A vertical (list) or any-direction (Board) move now
  drags-to-reorder.
- This gives Jim the exact rule he asked for: *"long-press-hold arms a drag; a horizontal
  move first = swipe."* One pointer pipeline, one arbiter — no two-system contention.

**Both views** share `indexAt`, the FLIP loop, and the lifted-layer render; the list
passes an `axis: 'y'` variant and the Board a 2-D variant. The persistence call is
identical (`reorderCustom`).

---

## 3. Masonry — pure-CSS feasibility (verified 2026)

### The verified browser facts (this is the load-bearing part)

There are **two different specs** people call "CSS masonry," and conflating them is the
main trap:

1. **`grid-template-rows: masonry`** — the *older* proposal.
   **Verdict: dead for Jim.** caniuse (`mdn-css_properties_grid-template-rows_masonry`)
   as of 2026: **Firefox 155+ only** (default), **Safari Technical Preview only — NOT in
   stable Safari/iOS through 26.5**, **Chrome: not supported**. Do **not** target this.

2. **`display: grid-lanes`** — the *new, settled* syntax ("CSS Grid Lanes"), the outcome
   of the multi-year `masonry`-vs-`item-flow` vendor debate.
   **Verdict: SHIPPED in Safari 26.4 / iOS 26.4 stable (March 2026)** — enabled by
   default, no flag. **This is Jim's primary browser.** Chrome and Firefox have it
   **behind an experimental flag** and are expected to ship stable "later in 2026."

Syntax:
```css
.board {
  display: grid-lanes;
  grid-template-columns: repeat(2, 1fr);   /* same explicit column counts as today */
  gap: 12px;
  flow-tolerance: infinite;                 /* ← preserve source/reading order */
}
```

### The order-correctness question (critical for a sorted notes board)

Grid Lanes' **default** placement is **shortest-column-first** — it drops each next card
into whichever lane is currently shortest. That produces a nice tight waterfall **but
scrambles reading order**: card 4 might land in column 2, card 5 in column 3, etc. For a
board whose order is *meaningful* (pin-partition then sort mode, from
`sortNotes`/`noteSort.ts:62`), that's unacceptable.

**`flow-tolerance: infinite` fixes exactly this** — it forces placement to **strictly
preserve source/DOM order** (fill across-then-down in order), giving up the tight-packing
in exchange for correct reading order. Since deltos already emits cards in the correct
`sortNotes` order in the DOM, `flow-tolerance: infinite` yields an **order-correct
masonry**: ragged heights, but rows read left-to-right, top-to-bottom, pins first. That is
the masonry Jim wants without breaking the sort.

### Why the `column-count` hack is disqualified

The classic pure-CSS masonry (`column-count: N`) lays out **column-major**: it fills
column 1 top-to-bottom, *then* column 2. So a reader going **left-to-right across a row**
sees items `1, ceil(N/…)` — the order jumps down-then-across. For an **ordered** notes
board (pins first, then sort), that inverts the intended reading order. **Confirmed
disqualifying** — do not use `column-count`.

### JS masonry (measure + absolute-position, or a lib like Masonry.js)

Cost: it must measure every card and absolutely-position it, re-run on resize, on content
change, and on every reorder. On a reactive note list that's constant re-layout work on
the main thread — a **direct hit to the load-feel north star**, and a new dependency (or
non-trivial custom code). **Critically it FIGHTS the FLIP reorder (§4):** JS masonry
*owns* each card's absolute `top/left`; the FLIP drag *also* wants to own transforms and
positions. Two systems writing position = conflict, double-layout, and jank. **Avoid.**

### Recommendation: **pure-CSS `display: grid-lanes` + `flow-tolerance: infinite`, progressively enhanced.**

```css
.board { /* current uniform grid — the FALLBACK, unchanged */
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
@supports (display: grid-lanes) {
  .board {
    display: grid-lanes;
    flow-tolerance: infinite;   /* order-correct masonry */
    /* drop the .board__card max-height cap so heights go content-driven (true masonry) */
  }
}
```

- **iOS Safari (primary):** true order-correct masonry, native, 0 kB, GPU-clean.
- **Laptop on Chrome/Firefox (2026, still flagged):** gracefully falls back to today's
  **uniform grid** — no masonry, but fully functional and identical to what ships now.
  When Chrome/Firefox ship grid-lanes (expected later in 2026) the laptop upgrades for
  free with no code change.
- Under masonry, remove/relax the `.board__card { max-height: 200px }` cap
  (`Board.css:41`) so card height is content-driven — that cap exists precisely because
  today's layout is a *uniform* grid of tiles; masonry wants ragged heights.

**Fallback caveat / open item:** confirm on Jim's *actual* laptop which browser it is. If
it's **Safari** (macOS 26.4+), it gets masonry too and there's no fallback story to worry
about. If Chrome, it's uniform-grid until Chrome ships. Either way iOS — the daily driver
— is covered today.

---

## 4. How #1 (drag reflow) and #3 (masonry) interact

They both need "measure rects," but they operate at **different layers** and compose
cleanly **if** we keep the ownership boundary strict:

- **Masonry (grid-lanes) owns RESTING layout.** It decides where every card sits when
  nothing is being dragged. It's pure CSS — no JS position-writing.
- **FLIP drag owns TRANSIENT motion.** During a drag it: (a) renders the lifted card in a
  raised layer with a `translate` following the finger, and (b) applies **transform-only**
  invert/play transitions to the *other* cards so they slide toward their new resting
  slots. It **never writes `top/left`** and never fights the grid — it only writes
  `transform`, which is composited *on top of* the grid-computed positions.
- **On drop**, FLIP writes a single order key (`reorderCustom`) → the note re-renders in
  its new DOM position → **grid-lanes re-flows the resting layout** to match. One final
  FLIP settles the transition. The transform is then cleared; CSS holds the final layout.

**This is exactly why hand-rolled FLIP + grid-lanes is the coherent pair, and why JS
masonry is not:** grid-lanes computes layout declaratively and leaves `transform`
untouched, so the FLIP overlay has a clean lane to animate in. A JS-masonry library, by
contrast, *also* writes positions/transforms and would collide.

**The one genuine risk (flag to Jim):** FLIP measures old→new rects assuming the grid
re-flows deterministically. In a **shortest-column masonry**, inserting a card can reshuffle
*many* cards' lanes, so the "invert/play" would animate lots of cards at once and could
look chaotic. **`flow-tolerance: infinite` (source-order) largely neutralizes this** —
order-preserving placement means an insert shifts cards in reading order (predictable,
like a list), not by lane-repacking. So the same setting that makes masonry *order-correct*
also makes it *FLIP-friendly*. Recommend building/validating the FLIP feel **on top of
`flow-tolerance: infinite`**, not default packing. Worth an on-device check once built.

---

## 5. Board visual tweaks (trivial CSS)

- **Zero border-radius cards:** `Board.css:41` — change `border-radius: 10px;` → `0`.
  (Also `Board.css:124` popover panel `border-radius: 18px` is the desktop note modal, a
  separate surface — leave unless Jim wants that squared too.)
- **Darker backing behind cards so cards pop:** the `.board` container (`Board.css:18`)
  currently has no background, so it inherits `--paper`/list bg. Add
  `background: var(--list);` (or `var(--nav)` for one step darker) to `.board`/`.board-view`
  — `--list` is authored one tone below `--paper` in every palette/mode
  (`theme/tokens.css`, e.g. ember light `--paper:#FFFFFF; --list:#F7F7F8;`), so cards on
  `--paper` sit above a slightly-darker field. In dark mode `--list` is also below
  `--paper` (`#161618` vs `#1A1A1D`), so it reads correctly in both. Pure token reuse, no
  new palette.

---

## 6. Build plan (lanes) — IF Jim approves the recommended approach

**Lane 0 — Board visual (tiny, ship first, independent):** zero radius + `--list` backing
in `Board.css`. No logic. (§5.)

**Lane 1 — FLIP reorder core (shared primitive):** a new hook
(`useReorderDrag`, replacing `useCustomOrderDrag`) that owns: long-press arm timer,
pointer capture, the `indexAt(x,y)` hit-test (generalize `indexAtY`), the FLIP
measure→reorder→invert→play loop, the lifted-layer render contract, and the swipe handoff
(cancel-arm on horizontal-first). Persist via the **unchanged** `reorderCustom`. Unit-test
the pure bits (index math, key computation — `noteSort`/`customOrderReorder` already
tested; add hit-test + arm-vs-swipe decision tests).

**Lane 2 — List integration:** wire `useReorderDrag` into `HomeView` (`App.tsx:387`), drop
the `⠿` grip (`App.tsx:407`) and the old `useCustomOrderDrag`. Long-press on the row body
arms; SwipeRow keeps horizontal. Component/integration test that MOUNTS the routed list and
asserts DOM reorder (`ui-features-need-rendered-ui-gate`).

**Lane 3 — Board integration:** wire the same hook into `Board.tsx` with the 2-D variant.

**Lane 4 — Masonry:** `@supports (display: grid-lanes)` block in `Board.css` +
`flow-tolerance: infinite`, relax the card `max-height` cap under masonry. Validate FLIP
feel *on top of* grid-lanes on-device.

**Lane 5 — On-device smoke (iOS Safari, the review gate):** deploy to
`deltos.blackgate.studio` (live = review). Verify: long-press lift + reflow feels fluid;
swipe still works and never mis-fires as a drag; masonry renders order-correct on iOS;
laptop fallback is clean.

**Perf gates throughout:** keep it in the lazy Board/List path (no new precache chunk);
transform-only animations (no `top/left`/width in the animated path); no new dependency.

---

## 7. Open questions for Jim (each with my rec)

1. **Which browser is the laptop?** Determines whether masonry works there today (Safari
   26.4+ = yes; Chrome/Firefox = uniform-grid fallback until they ship grid-lanes).
   *Rec:* proceed regardless — iOS is covered now, the fallback is graceful. Just tells us
   what to expect on the laptop.
2. **Under masonry, drop the card height cap entirely (true ragged masonry) or keep a
   generous cap (bounded tiles that still stagger)?** *Rec:* drop it for real masonry —
   that's the point of the change; a cap re-flattens it. Long notes still clamp text via
   the existing `-webkit-line-clamp`.
3. **Long-press delay ~250 ms — comfortable, or does he want snappier/longer?** *Rec:*
   start at 250 ms (dnd-kit's proven touch default) with ~8–10 px tolerance; tune on
   device.
4. **Keep a discoverability affordance now that the grip `⠿` is gone?** (long-press has no
   visual hint). *Rec:* rely on the lift/haptic feedback on arm; add a one-time hint later
   only if Jim finds it undiscoverable — it's his personal app, muscle memory forms fast.

---

## Sources (load-bearing facts)

- CSS Grid Lanes shipped Safari 26.4 (March 2026), syntax, shortest-column vs
  `flow-tolerance: infinite` source-order: WebKit blog "Introducing CSS Grid Lanes"
  (https://webkit.org/blog/17660/introducing-css-grid-lanes/); ICS Media
  "Creating masonry layouts in CSS with display: grid-lanes"
  (https://ics.media/en/entry/260611/); Blake Crosley "CSS Grid Lanes: Native Masonry in
  Safari" (https://blakecrosley.com/blog/css-grid-lanes-2026).
- `grid-template-rows: masonry` NOT in stable Safari/iOS (Firefox-only, Chrome none):
  caniuse (https://caniuse.com/mdn-css_properties_grid-template-rows_masonry).
- dnd-kit bundle + versions (core 6.3.1, sortable 10.0.0, utilities 3.2.2; core ~10 kB
  min / ~18.9 kB reported): Bundlephobia (https://bundlephobia.com/package/@dnd-kit/core,
  https://bundlephobia.com/package/@dnd-kit/sortable); dnd-kit GitHub
  (https://github.com/clauderic/dnd-kit).
- dnd-kit PointerSensor `activationConstraint { delay, tolerance }` for long-press vs
  swipe (touch default 250 ms / 5 px): dnd-kit sensors docs
  (https://docs.dndkit.com/api-documentation/sensors,
  https://docs.dndkit.com/api-documentation/sensors/pointer).
- framer-motion ~30–32 kB gzip, poor tree-shaking, `LazyMotion` → ~4.6 kB initial:
  Motion "Reduce bundle size" (https://motion.dev/docs/react-reduce-bundle-size);
  Bundlephobia (https://bundlephobia.com/package/framer-motion).
