# Best web mobile drag-to-reorder, mid-2026 — research report

> Crew research deep-dive (2026-07-09), commissioned after the hand-rolled Pointer-Events+FLIP
> long-press reorder (ROAD-0019) was ripped out (@c14b4e5). Feeds the 3-candidate demo surface.

## 1. Executive verdict

The 2026 landscape has a clear shape: **dnd-kit is the only actively-developed library that genuinely solves touch-drag-coexisting-with-scroll AND 2D reorder** — but it exists as two divergent lines (frozen legacy vs pre-1.0 rewrite), and masonry/variable-height is its known soft spot with a documented workaround path. Everything else fails at least one hard requirement. The top 3 to build as live demos:

1. **dnd-kit legacy (`@dnd-kit/core@6.3.1` + `@dnd-kit/sortable@10.0.0`)** — the battle-tested community standard (Linear, Vercel use it; ~2.8M weekly downloads). Dedicated `TouchSensor` with `delay+tolerance` long-press activation is the proven iOS scroll-coexistence recipe; every masonry workaround on record was developed against it. Frozen (last release Dec 2024) but stable and React 18-fine.
2. **dnd-kit next (`@dnd-kit/react@0.5.0`, June 2026)** — where all development now goes; framework-agnostic core, React 18/19 peer deps, and crucially ships `directionBiased` collision detection — the recommended fix for exactly our variable-height/masonry jitter problem. Risk: pre-1.0 API churn and open touch-delay bug reports against its unified PointerSensor.
3. **SortableJS `@1.15.7` (core driven directly, no React wrapper)** — the only other true insert-reorder engine with real touch mileage (~3.85M weekly downloads, `delayOnTouchOnly` long-press model). Kept as the pragmatic control/fallback: enormous real-device track record, but semi-dormant maintenance, an abandoned React wrapper, and known variable-height-grid bugs.

Cross-cutting: the **View Transitions API is now Baseline (Safari 18+/iOS included, Oct 2025)** and can serve as a native, zero-dep FLIP animation layer for the *settle* animation over any of the three.

## 2. Candidate table

| Library | Version / last release | Gzip size | Touch mechanism | Masonry / variable-height | Maintenance 2026 | Key risks |
|---|---|---|---|---|---|---|
| **dnd-kit legacy** (core+sortable) | 6.3.1 / 2024-12-05 | ~17.5 kB combined | `TouchSensor` activation constraint `{delay:250, tolerance:5}`; long-press drags, swipe scrolls; needs `touch-action` CSS | Grid via `rectSortingStrategy` (uniform-ish only); variable-height = open flicker bug #1950 ("has workaround"); masonry needs custom collision + move | Frozen — no new releases; maintainer redirects to next line | Dead-end for fixes; slow mobile auto-scroll #1992; iOS address-bar-resize kills in-flight drag (historical #686/#866) |
| **dnd-kit next** (`@dnd-kit/react`) | 0.5.0 / 2026-06-11 (0.5.1-beta 2026-07-06) | not yet on bundlephobia; expect ≈ legacy | Single `PointerSensor`, composable activation constraints (v0.2.0 refactor, Dec 2025); no dedicated TouchSensor | Ships `directionBiased` collision detector + custom `move` — the documented fix for variable-height; still repros flicker with defaults (#1950/#2088 open) | Very active (pushed 2026-07-06); near-solo maintainer; "production ready, pre-1.0" | API churn before 1.0; open touch reports: delay misbehaving on touch, stuck cards (#1723) |
| **SortableJS** (direct, no wrapper) | 1.15.7 / 2026-02-11 | ~15 kB | `delay` + `delayOnTouchOnly:true` + `touchStartThreshold` long-press; fallback (non-HTML5) drag path on touch | Variable-height *lists* fine; variable-height *grids* buggy (#2335 recursive position change); no masonry model (assumes visual order = DOM order) | Semi-active/bursty (14-month gap broken Feb 2026); 523 open issues; react-sortablejs wrapper **abandoned** (2022) | iOS-version regressions (e.g. #2374 broke on iOS 17.4); React integration is DIY imperative; DOM-mutation-vs-React-state trap |
| Pragmatic DnD (reject) | 2.0.1 / ~2026-06 | ~4.7 kB core | Native HTML5 DnD API | You build everything; no masonry story | Actively maintained by Atlassian | **Touch on iOS effectively broken** (~10% drop success reported, unanswered issues) — dealbreaker |
| Motion `Reorder` (reject) | 12.42.2 / 2026-06-30 | Reorder pulls heavy bundle | Needs `touch-action` that kills list scroll; scroll-vs-drag conflict maintainer-**wontfix** (#1506) | **1D single-axis only**; no grid, no masonry | Very active | Structurally unfit |
| Swapy (reject) | 1.0.5 / 2025-01-19 | ~8.3 kB | Pointer-based; unresolved mobile scroll bugs | **Swap-only** (pairwise exchange, never insert-and-shift); no masonry | **Stagnant ~18 months** | Wrong semantics for a notes list |
| @formkit/drag-and-drop (reject) | 0.6.1 / 2026-06-15 | ~4 kB | Pointer events; no documented scroll-disambiguation | **Linear lists only** — no 2D, no masonry | Active | 1D ceiling |

## 3. Per-candidate detail (top 3)

### Candidate 1 — dnd-kit legacy (`@dnd-kit/core` + `@dnd-kit/sortable`)

- **Touch activation model.** Register `TouchSensor` (not just PointerSensor) with activation constraint `{ delay: 250, tolerance: 5 }`: a quick swipe never activates the drag (native scroll proceeds); a 250ms hold with <5px finger drift starts it. TouchSensor can `preventDefault` inside `touchmove` — which pointer events cannot — making it the more reliable iOS path. CSS: `touch-action: manipulation` on sortable items (or `none` on dedicated handles). Historical `pointercancel` mishandling was patched (PRs #1888/#1889/#1541) and mostly affects PointerSensor, not TouchSensor.
- **Masonry approach.** `rectSortingStrategy` assumes a roughly uniform grid and is *not* masonry-aware (#1223 closed without a first-class answer). The open flicker bug #1950 root cause: the built-in insert-before/after decision uses cursor top-half/bottom-half of the target — unstable when neighbors differ greatly in height. Build plan: CSS Grid row-span masonry (DOM order preserved), `useSortable` items + `DragOverlay` for the drag ghost (keeps layout static under the finger), `closestCenter` collision, and reorder-on-`onDragOver` with your own index math rather than trusting the strategy's transform preview for the masonry view. Let the grid reflow animate via FLIP (dnd-kit's built-in) or View Transitions.
- **React wiring.** `<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={...}><SortableContext items={ids} strategy={...}>` + `useSortable` per card + `<DragOverlay>`. Pure hooks; lazy-loadable as its own chunk trivially.
- **iOS-Safari findings.** Open: #1992 painfully slow mobile auto-scroll (test early — long lists need it); #1955 Android drag-start on some devices. Historical: iOS 15 address-bar show/hide resize events interrupt an in-flight drag (#686/#866) — the installed-PWA standalone mode largely sidesteps the address bar, but test viewport-resize-during-drag anyway.

### Candidate 2 — dnd-kit next (`@dnd-kit/react`)

- **Touch activation model.** One unified `PointerSensor` with a composable activation-constraints API (rewritten v0.2.0, Dec 2025) with per-input-type defaults; conditional sensor activation on interactive elements. There is **no dedicated TouchSensor** — issue #1723 (open) reports delay misbehaving on touch screens and cards sticking, with thin docs. The demo must explicitly configure the delay/tolerance constraints for touch and validate on a real iPhone; this is the candidate's biggest unknown.
- **Masonry approach.** This is where the rewrite earns its slot: use the **`directionBiased` collision detector** and bypass the built-in `move` with custom reorder logic — the documented workaround for #1950's variable-height jitter, four-directional so no dead zones between very different-height cards. `@dnd-kit/helpers` provides `move()` for the state update. Same CSS-grid-row-span masonry substrate as candidate 1.
- **React wiring.** `<DragDropProvider onDragEnd={...}>` + `useSortable({ id, index })` from `@dnd-kit/react/sortable`; framework-agnostic `DragDropManager` underneath; React 18/19 peer deps explicit.
- **iOS-Safari findings.** #1950 flicker repros in the *next* Storybook too with defaults (hence the custom collision requirement); #2088 (June 2026) fresh jitter reports; #1723 touch-delay issues. Active repo (pushed 2026-07-06), but near-solo maintainer and pre-1.0 semver.

### Candidate 3 — SortableJS 1.15.7, direct integration

- **Touch activation model.** `{ delay: 250, delayOnTouchOnly: true, touchStartThreshold: 5, animation: 150 }` — long-press on touch only, desktop drags immediately. Uses its fallback (synthetic) drag path on touch rather than native HTML5 DnD. Massive real-world mobile mileage, but the tracker shows recurring iOS friction (#1103 scroll issues, #2044 over-sensitive touch, #2374 iOS 17.4 regression) — iOS-version regression risk is structural because maintenance is bursty.
- **Masonry approach.** Weakest of the three. SortableJS reorders the actual DOM and assumes sibling order == visual order, so: CSS Grid row-span masonry (never CSS columns), and recompute spans after `onEnd`. Variable-height grid has an open recursive-position-change bug (#2335). Expect the masonry demo to be the stress test that likely eliminates it.
- **React wiring.** Do **not** use react-sortablejs (abandoned 2022, no React 18/19 peer deps). Drive core directly: `useEffect(() => { const s = Sortable.create(ref.current, opts); return () => s.destroy(); }, [])`. The classic trap: SortableJS mutates the DOM, React owns the vDOM — in `onEnd`, revert the DOM move (or key items stably) and apply the reorder to React state instead.
- **iOS-Safari findings.** ~500ms-hold-then-drag works on iOS but delay handling has differed per platform (#1556 Android delay ineffective); PointerEvent handling historically weak in Safari (#1436).

## 4. Rejects (don't re-litigate)

- **Pragmatic drag and drop (Atlassian)** — built on native HTML5 DnD; touch on iOS Safari is effectively broken (~10% drop success reported, unanswered issues). Superb for desktop web at Jira scale; dealbreaker for a touch-first PWA.
- **Motion (Framer Motion) `Reorder`** — strictly single-axis 1D; scroll-vs-drag on touch is maintainer-`wontfix` (#1506); required `touch-action` kills list scrolling; Reorder pulls the heavy bundle.
- **Swapy** — swap-only semantics (pairwise exchange, never insert-and-shift): architecturally wrong for a notes list. Also stagnant since Jan 2025, unresolved mobile-scroll bugs.
- **@formkit/drag-and-drop** — tiny and active, but linear-lists-only; no 2D grid, no masonry.
- **Neodrag** — draggable primitive only; no sortable/reorder logic at all.
- **react-beautiful-dnd / hello-pangea/dnd** — rbd long dead; the pangea fork is maintenance-only, vertical/horizontal lists only, no grid/masonry, no new investment.
- **Gridstack.js / Puck** — dashboard-widget and page-builder tools respectively; wrong shape for note-list reorder.
- **View Transitions API alone** — animation layer, not a drag engine; blocks interaction during transitions (bad mid-drag). Use it for the post-drop settle animation, not the gesture. (Baseline: Safari 18+/Chrome 111+/Firefox 133+.)

## 5. Demo-build notes

All three demos share: list view + uniform CSS-grid view + masonry view (CSS Grid + `grid-row: span N` computed from card height — keeps DOM order meaningful, which all three candidates require); each loaded as a lazy route-level chunk; long-press activation ~250ms/5px everywhere; test on real iPhone Safari standalone PWA.

**Demo 1 — dnd-kit legacy:** install `@dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2`. Trickiest: (a) register `TouchSensor` + `MouseSensor` explicitly (not the default PointerSensor) with `useSensors`, `{delay:250, tolerance:5}` on touch only; (b) `touch-action: manipulation` on items and use `DragOverlay` so the source card doesn't fight the masonry reflow; (c) for the masonry view, do NOT trust `rectSortingStrategy` — reorder state in `onDragOver` with custom index logic + `closestCenter`, and verify the #1950 flicker workaround holds with wildly different card heights.

**Demo 2 — dnd-kit next:** install `@dnd-kit/react@0.5.0 @dnd-kit/helpers` (pin exact versions — pre-1.0 breaking changes are live; `@dnd-kit/dom`/`abstract` come as deps). Trickiest: (a) explicitly configure PointerSensor activation constraints for touch — defaults are the subject of open bug #1723, so validate long-press vs scroll on a real device first thing; (b) masonry view must use the `directionBiased` collision detector + custom move, not defaults (this is the library's own recommended fix for variable-height jitter); (c) expect thin docs — read the Storybook source in the repo's `apps/stories` for canonical patterns.

**Demo 3 — SortableJS:** install `sortablejs@1.15.7` only (no react-sortablejs). Trickiest: (a) the DOM-vs-React ownership dance — revert Sortable's DOM mutation in `onEnd` and reorder React state, with stable keys; (b) options `{delay:250, delayOnTouchOnly:true, touchStartThreshold:5, animation:150}` and test that scroll still works on iOS (issue #2044 class); (c) the masonry view is its known failure mode (#2335) — build it anyway as the elimination test, recomputing row spans after every reorder.

## 6. Sources

- dnd-kit: https://github.com/clauderic/dnd-kit · https://github.com/clauderic/dnd-kit/releases · https://dndkit.com/react/guides/sensors/ · https://dndkit.com/react/guides/collision-detection/ · https://dndkit.com/legacy/api-documentation/sensors/touch/ · npm @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/react
- dnd-kit issues: #1950 variable-height flicker · #2088 jitter · #1223 masonry · #1723 TouchSensor alternative · #1992 slow mobile auto-scroll · #1955, #686, #866, #1333 · PRs #1888/#1889/#1541 · discussions #1803, #1842, #1156
- SortableJS: https://github.com/SortableJS/Sortable · issues #1103, #1556, #2044, #2374, #1436, #2335, #2144, #2269
- Swapy: https://github.com/TahaSh/swapy · issues #47, #30, #73, #110, #70, #45
- Motion: https://motion.dev/docs/react-reorder · https://github.com/framer/motion/issues/1506 (+#1341/#1482/#1582/#1597)
- Pragmatic DnD: https://atlassian.design/components/pragmatic-drag-and-drop/
- FormKit: https://drag-and-drop.formkit.com/ · Neodrag: https://www.neodrag.dev/docs/react
- View Transitions: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API · https://caniuse.com/view-transitions
- Comparisons: https://puckeditor.com/blog/top-5-drag-and-drop-libraries-for-react · https://www.pkgpulse.com/guides/dnd-kit-vs-react-beautiful-dnd-vs-pragmatic-drag-drop-2026 · https://drag-and-drop-performance-comparison.vercel.app/
