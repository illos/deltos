# Spec — Search (notebook-aware, fuzzy, local) v1

**Status:** SHIPPED — v1 live 2026-06-24.
**Design basis:** `[[notebooks-and-search-plan]]`, `[[ui-view-driven-architecture]]`. Locked with the user 2026-06-18.
**Depends on:** `docs/specs/ui-backbone-notebooks.md` — needs real notebooks + the **collection-view seam** (search results = a collection-view). **Sequence AFTER backbone+notebooks lands.**

## Goal
Account-wide search that **prioritizes the current notebook** and surfaces matches in other notebooks without leaving the current context. Fast, fuzzy, fully local/offline.

## Entry & behavior
- Entry point: the `🔍` in the notebook-view top bar → opens a **full-screen search** surface, field focused, keyboard up.
- **Search-as-you-type** (live, debounced).
- **Fully local / offline / client-side** over the synced local store — no server round-trip; instant; works offline. (The server `note.search` op is untouched; v1 client search does not use it. Large-scale indexing is a future perf item, not v1.)
- **Searches title + body text.** (Property/tag search = later, out of scope.)
- **Fuzzy by default** — typo-tolerant approximate matching, not plain substring.
- **Relevance-ranked** — best matches first; **title matches weighted above body matches**. (Reuse a vetted approach per reuse-discipline — rewrite to deltos quality, no patch-and-paste.)
- **Scope:** always across the whole account; current-notebook prioritized. **No "this notebook only" toggle in v1.**

## Results layout
- **Current notebook = headline:** its matches shown first, **flat, fully expanded**, under an "IN <notebook>" header.
- **Other notebooks = surfaced but collapsed:** each a header **"<Notebook name> (N)"**; **tap expands in place (accordion)** to reveal that notebook's matching notes. No navigation to expand.
- **Result row = title + snippet:** the note title PLUS a **snippet around the best match**, with **matched terms/characters highlighted**, and a timestamp. (Reuses the collection-view seam's row rendering where sensible; search rows add the snippet.)
- **Tapping a result** opens the note in the item view (editor). It **does NOT change the current notebook** — peeking via search; back returns to results / the home notebook. Current-notebook only changes via deliberate switching.
- **Empty states:** before typing = blank (recents/recent-searches = later); no matches = a plain "no results" message.

## Constraints
- Holds `[[performance-is-a-standing-value]]`: results feel instant; fuzzy ranking is debounced + capped so a large local set never janks the keystroke. No full-page reloads; in-place reactive.
- Search results are a **collection-view** (per `[[ui-view-driven-architecture]]`) — reuse the seam from the backbone spec, don't build a one-off list.
- Local-only read path; respects account scoping (only the signed-in account's local data is searchable — no cross-account leakage by construction since the local store is account-scoped).

## Acceptance criteria
1. Typing incrementally filters; results update live without lag on a realistic local note count.
2. Fuzzy: a query with a typo (e.g. "cofee") still finds "coffee" notes.
3. Relevance: title matches rank above body-only matches; best match first.
4. Current-notebook matches appear first as a flat list; other notebooks appear as collapsed "(N)" headers that expand in place.
5. Each row shows title + a highlighted snippet around the match.
6. Tapping a result in another notebook opens that note but leaves the current-notebook pointer unchanged (verify: back returns to the original notebook).
7. Works offline (airplane mode) over the local store.

## Out of scope (explicit)
- Property/tag/structured-field search; "this notebook only" toggle; recent-searches / recents-before-typing; saved searches; server-side / large-scale indexed search; cross-notebook "all results merged" flat mode.
