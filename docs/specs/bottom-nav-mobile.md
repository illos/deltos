# Spec — Bottom Nav Bar (mobile) v1

**Status:** SHIPPED — v1 live 2026-06-24.
**Supersedes:** the mobile/tablet-portrait LEFT-DRAWER container from #21 (NavContent is reused — only the container changes).
**Design basis:** `[[ui-view-driven-architecture]]`. Locked with the user 2026-06-18 (glass-test #2).

**Update (2026-06-24):** Mobile nav as shipped = top-bar (notebook name / context) + **BottomNav** in
default mode. BottomNav is **SUPPRESSED in deck-custom keyboard mode** — when the Deck custom keyboard
is active, it occupies the bottom footprint and BottomNav is hidden. Cross-ref: `docs/specs/custom-keyboard.md §4`.

## Why
On iOS, **left/right EDGE-SWIPE = Safari/PWA back/forward**, both owned by the platform. A side slide-out drawer can never own its open gesture, so the left-drawer's "slide-out" was dead — only the hamburger tap worked. Moving mobile nav to the **bottom** sidesteps edge gestures entirely and is more thumb-reachable.

## Scope (mobile + tablet-portrait only)
- **Bottom nav bar** pinned to the bottom, thumb-reachable, **safe-area aware** (respect home-indicator / notch insets — `env(safe-area-inset-bottom)`; don't get occluded).
- **Collapsed row = LEAN: New note + Search.** Build it as an **extensible action-slot row** (a registry of actions, not two hardcoded buttons) so future tooling/plugins contribute actions over time — consistent with the plugin-first / view-driven doctrine ([[ui-view-driven-architecture]]). Ship exactly New note + Search now.
  - New note → creates in the **current notebook** (absorbs the old FAB).
  - Search → opens the search surface (#20, wired later; entry lives here now).
- **Drag UP (and tap the handle) → expand into the FULL MENU** = reuse the existing **NavContent** (notebook switcher with counts + New notebook + Trash + Settings/account). **Collapse** on selection, swipe-down, or tap-scrim.
- **DROP the FAB and the hamburger** — both fold into the bottom bar.
- **Top bar shrinks** to the current-notebook-name as context (no menu trigger).
- Note list stays the main screen; active note stays a pushed sub-screen (unchanged).
- **No reliance on edge-swipe** for opening anything (the whole point).

## Desktop + tablet-landscape
**Unchanged** — left nav pane stays (no edge-gesture problem there). This spec is mobile-only.

## Architecture
One nav surface, **three containers**: **left pane** (desktop) / **bottom sheet** (mobile, this spec) / **full-screen** (cold-start fallback). NavContent is the single shared component; only the container differs. The collapsed-row actions (New note, Search) are a small registry so the set is data-driven, not hardcoded.

## Interaction defaults (validate on-device, tune freely)
- Drag the bar/handle **up** to expand; **tap** the handle also expands.
- Collapse on: selecting an item, swipe-down, tap the scrim.
- Smooth, in-place (no full-page reload); honors the load-feel bar.

## Acceptance criteria
1. Bottom bar visible + thumb-reachable on mobile; correct on a notched device (safe-area insets, not occluded by the home indicator).
2. New note (bottom bar) → creates in the current notebook.
3. Search (bottom bar) → opens the search surface (stub ok until #20).
4. Drag-up / tap-handle → full NavContent (notebooks + new notebook + trash + settings); selecting a notebook navigates to its list and collapses the sheet.
5. Nothing relies on an edge-swipe to open; no conflict with Safari/PWA back/forward.
6. Desktop/tablet-landscape left pane unaffected.
7. The collapsed action row is registry-driven (a test/throwaway third action can be registered to prove extensibility — not shipped).
8. Render-test + on-device smoke gate (per [[ui-features-need-rendered-ui-gate]]) before deploy.

## Out of scope
- Additional bottom-bar tools/actions (future, via the registry); any desktop change; the visual restyle (look-and-feel pass); the B1/B2/B3 bug fixes (separate — though B1's delete-notebook UI lives in NavContent which now renders in this bottom sheet; coordinate so it appears in the expanded menu).
