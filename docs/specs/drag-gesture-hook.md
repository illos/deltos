# Spec — Shared drag-gesture hook + native bottom-sheet drag

**Status:** SHIPPED — v1 live 2026-06-24.
**Origin:** glass-test — the bottom-nav "drag" feels like a tap (jerky, no drag-down). Investigation found it's fake (30px threshold flipping a boolean + a CSS `max-height` transition). The note-list **SwipeRow** gesture, by contrast, feels polished and is the reuse target ([[swipe-actions-spec]] / [[swipe-trash-feature-shipped]] — user-validated "feels great"). User: "let's do it and see how it feels."

## Goal
Make the mobile bottom-sheet drag **native-smooth** by **re-adapting our own SwipeRow gesture engine** into a shared, axis-parameterized hook — **no new dependency, no fresh hand-roll**. Reuse-discipline: extract + generalize OUR proven code; do not add a gesture/animation library.

## Reference (what SwipeRow already does right — `components/SwipeRow.tsx`)
Hand-rolled Pointer Events; 1:1 finger-following `transform: translateX` every move; all drag state in a `useRef` (no re-render in the hot path → 60fps); 8px dominant-axis lock; `setPointerCapture`; rubber-band clamp; position-threshold snap via add-class/set-transform/remove-on-`transitionend`; GPU `transform` + `will-change`. These polished parts are **axis-agnostic**.

## Scope
1. **Extract a shared hook** (e.g. `useDragAxis`) from SwipeRow — the pointer/ref/axis-lock/capture/GPU-transform/snap machinery, parameterized on axis (X or Y) and snap points.
2. **Refactor SwipeRow to consume it** — **behavior must stay identical** (it's user-validated "feels great"; regression-check on device, do NOT regress it).
3. **Drive the bottom-nav sheet with it (vertical):** convert the sheet from `max-height` to a **full-height sheet parked off-screen via `translateY`**, dragged into view; 1:1 finger-follow up AND down; **two snap points** (closed / open ~75vh); snap on release by position; interruptible.
4. **Inner-scroll vs. dismiss (net-new):** a downward drag collapses the sheet **only when its content is scrolled to top**; otherwise the drag scrolls the menu. (SwipeRow never needed this.)
5. **Optional upgrade:** velocity-based snap (record last dy/dt in the ref) — a genuine improvement the swipe-row doesn't even have; do if cheap.
6. Keep tap-to-expand + tap-scrim/handle-to-collapse working; keep the body-scroll-lock working with the `translateY` approach **without** reintroducing reflow jank.

## Constraints
- **Zero new dependencies** (reuse our engine).
- GPU `transform` + `will-change` only — **no animating layout properties** (`max-height`/`height`/`top`); that was the jank source.
- Ref-state hot path — no React re-render mid-drag.
- SwipeRow stays identical — user-validated; protect it.
- Holds [[performance-is-a-standing-value]]; under the [[ui-features-need-rendered-ui-gate]] (render tests + mobile-viewport browser smoke + on-device feel = explicit DoD, smoke→deploy→report, NOT done-at-build).

## Acceptance criteria
1. The sheet follows the finger 1:1 on drag **up and down**; snaps open/closed on release; interruptible.
2. Drag-down collapses only when the menu is scrolled to top; otherwise scrolls.
3. tap-to-expand + tap-scrim/handle collapse still work.
4. No jank — transform/GPU, smooth as the swipe actions.
5. **SwipeRow behavior unchanged** (on-device regression check).
6. **FEEL: the user verifies on device** ("see how it feels") — this is the real verdict; expect a tuning pass (snap thresholds, rubber-band, optional velocity).

## Out of scope
- Any gesture/animation library (explicitly rejected). Other surfaces. The desktop pane (unaffected).

## Sequencing
Client lane is on Search (#20). Queue this after Search deploys, or pull a spare client hand — pilot's call. Not blocking Search.
