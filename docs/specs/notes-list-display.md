# Notes List Display — full-bleed rows + title fallback + date & preview

**Status:** SPEC-READY (planSys, 2026-06-17, from on-device glass-test feedback). Handoff = pilot. Surface =
`HomeView` in `App.tsx` + the `SwipeRow` component. Client-only (gruntSys2 lane); can run **parallel to the
auth pivot** (different surface). Part of the "basic notes, day-to-day usable" milestone (view-notes polish).
Hold the **performance standing-value** ([[performance-is-a-standing-value]]) — the list is the hot load path.

## Context
On-device swipe feel verdict = **GREAT (no threshold/easing changes requested)** — the gesture is accepted;
this spec is the list *presentation* + one swipe bug.

## Items

### 1. BUG — underlying swipe buttons poke out ~1px on the top note
On the **topmost** row, the action panel beneath the foreground peeks ~1px at the top edge. Almost certainly
a rounding / overflow / border-alignment gap between the foreground and the panel at the first row's top.
Fix: the foreground must fully cover the panel (`overflow-hidden` on the row container + exact edge
alignment; the full-bleed restyle in #2 likely subsumes the rounded-corner cause). Verify on-device.

### 2. Full-bleed list — edge-to-edge, full width, NO border box
Notes render **edge-to-edge, full width, with no card / border / rounded box** per note (drop the carded
look). Apple-Notes-style flat list. **Recommended:** separate rows with a **subtle hairline divider** (not a
box) for scannability — gruntSys2's call. The full-bleed layout should also resolve #1's rounded-corner
cause. Swipe panels reveal at the screen edge (cleaner with no rounded corners).

### 3. Title fallback — blank title + body present → first words of body
When `note.title` is empty/blank but the body has text, the **all-notes list** shows the **first few words of
the body** as the title (display-only — do NOT write it back to the title field; the note's real title stays
empty). If both title and body are empty → existing "Untitled" placeholder.

### 4. Last-edited date + one-line preview (clipped)
Each row shows, below the title line:
- **Last-edited date** from `note.updatedAt`. **Format (recommended, Apple-Notes-style smart):** today →
  time (e.g. "2:30 PM"); yesterday → "Yesterday"; this year → "Jun 12"; older → "Jun 12, 2024".
- **One-line text preview** = the first line of body plaintext, **single line, clipped to row width** with
  ellipsis (`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`).
- Arrangement (date then preview on the secondary line, or date as a leading label) = gruntSys2's design
  call; keep it one clipped line.

## Shared derivation (items 3 + 4)
Both need **plaintext extracted from the body** (ProseMirror doc). Add a small helper
(`notePreview(note) → { titleFallback, previewLine }`) — reuse `editor/serializer.ts` if it already does
plaintext; otherwise a minimal first-text-content extractor. **Confirm the title/body model with the editor
owner** (title is unified as the first heading in the PM doc — the helper must extract the title node vs the
first body text correctly).

**PERF (standing-value, hot path):** derive **cheaply** — pull only the first text content / first line, NOT
a full-doc serialization, and run it per-row on render. If the list-render measurably regresses the
beat-Apple-Notes load-feel, **denormalize**: compute + store `previewLine`/`titleFallback` on the note at
save-time instead. Start cheap-on-render; measure; only denormalize if needed (YAGNI). Report any bundle/
render delta.

## Acceptance
1. No button poke-out on any row incl. the top one (on-device).
2. List is full-bleed edge-to-edge, no per-note border box.
3. Blank-title + body → first words of body shown as the list title (not persisted); both-empty → "Untitled".
4. Each row shows the smart last-edited date + a single clipped one-line body preview.
5. Load-feel unchanged (perf budget held); swipe + tap-to-open + conflict badge still work on the new rows.
