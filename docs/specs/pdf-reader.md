# PDF Reader — Design + Build Spec

**Status:** DESIGN → BUILD-READY (approach settled by Jim; this is the done-gate for the
build that follows).
**Date:** 2026-06-28.
**Depends on:** the file-notes feature (`file-notes.md`) — `FileNoteView`, the `isFileNote`
discriminator, `blobClient`, and the authenticated blob GET are all **BUILT + live**. See
`file-notes.md` §3.2 (the open surface this replaces for pdfs) and §3.2.2's "No preview
available" branch (the exact thing this supersedes for the `pdf` type).
**Approach:** SETTLED by a prior exploration — **client-side pdf.js**, parse-not-execute,
canvas + inert text layer. The sandboxed-iframe / native-viewer path was **REJECTED on
security grounds** and is not relitigated here (§7).
**New infra:** ZERO. No new Worker route, no schema/migration/sync change, no new binding.
One new client dependency (`pdfjs-dist`) loaded as a lazy, off-main-thread chunk.

---

## 0. The one-line thesis

A **PDF reader** is a first-class in-app viewer rendered inside `FileNoteView` for
`pdf`-type file notes — *"so I don't have to download files to look at them"* (Jim, firm).
It **replaces** the current pdf branch of `FileNoteView` (a format icon + "No preview
available" + Download) with a real reader: a **scrollable multi-page canvas viewer**, a
**page-thumbnail strip**, **jump-to-page**, and **in-PDF text search**.

The PDF bytes come from the **existing authenticated `GET /api/plugin/blob/:hash`** (octet-
stream + `Content-Disposition: attachment` — never inline-served as active content). They
are **parsed by pdf.js in an off-thread Web Worker** and **rendered to `<canvas>`** (plus a
positioned, inert text layer for search). pdf.js does **not** execute embedded PDF
JavaScript — scripting is an opt-in module we leave **OFF**. The safe-serving boundary in
`packages/worker/src/routes/blob.ts` is **untouched**: no new route, no inline PDF serving,
the blob is fetched as bytes by authenticated `fetch` and rendered entirely client-side.

This is **NOT** an inline editor content block — it is **only** the file-note open surface
for the `pdf` type. It slots into the same perf lane as the existing **424 KB SymSpell
`spellEngine`** (a lazy, off-main-thread, dynamic-imported chunk): pdf.js loads **only when
the user first opens a PDF file note**, runs its parse in a worker, and is **runtime-cached
after first load** so subsequent PDF views work offline (§6).

---

## 1. What this IS (and is not)

- **IS:** a bespoke pdf reader rendered *inside* `FileNoteView` when the open file note's
  file format is `pdf`. The reader owns the preview region; the surrounding `FileNoteView`
  chrome (header, Download, Rename, Delete, metadata) stays. Download still yields the raw
  PDF bytes — the reader is *additive*, not a replacement for "get the file off-device."
- **IS:** parse-not-execute. pdf.js reads the PDF's content streams and draws them; it
  never runs the PDF's own scripts, never opens a native viewer, never inline-serves bytes
  as active content on the app origin.
- **IS NOT:** a `/`-palette block, a mid-document embed, or anything that ships to first
  load. It is a second-level lazy chunk *inside* an already-lazy `FileNoteView` (§5).
- **IS NOT:** a PDF *editor* (no annotation, no form-fill, no page reorder). Read-only.
- **IS NOT:** an offline-PDF-content store. The reader *engine* works offline once cached;
  the PDF *file itself* still requires the network to fetch (then renders fully in-app).
  Caching PDF content for offline reading is **deferred** and flagged (§6.4, §9 OQ-1).

---

## 2. The seam — pdf file note → `FileNoteView` → reader

The wiring reuses the existing file-note open path with **one new branch** inside
`FileNoteView` and **one new helper** in `blobClient`.

### 2.1 Detecting the pdf type

`FileNoteView` already derives the attachment (`fileNoteAttachment(note)` → `{ hash, name,
mime, size }`). PDF detection mirrors the existing `isPreviewableImage` predicate shape — a
tiny local predicate, mime-first with an extension fallback:

```ts
function isPdf(mime: string, name: string): boolean {
  return mime === 'application/pdf' || /\.pdf$/i.test(name);
}
```

When `isPdf(...)` is true, the preview region renders the **`<PdfReader hash={hash}
name={name} />`** lazy component **instead of** the current "No preview available" icon
block. Every other branch of `FileNoteView` (image preview, the generic no-preview icon,
Download/Rename/Delete/metadata) is **unchanged** — this is a surgical addition to the one
branch that today shows nothing useful for pdfs.

### 2.2 The bytes — a new `blobClient` helper

The reader needs the **raw `ArrayBuffer`** (pdf.js parses bytes, not an object URL). Add one
thin helper to `blobClient.ts`, a sibling of `loadBlobUrl`, content-addressed + session-
cached by hash (reuse the existing cache pattern, but cache the bytes, not an object URL):

```ts
/** Load a blob's raw bytes for a parser that needs the ArrayBuffer (the pdf reader). Authenticated
 *  GET /api/plugin/blob/:hash — the SAME route + octet-stream + attachment serving as every other
 *  blob fetch (no inline serving, no new route). Throws on miss/offline; the caller degrades. */
export async function loadBlobBytes(hash: string): Promise<ArrayBuffer>;
```

- It carries the bearer (`authHeaders()`), hits the **existing** `GET ${BLOB_API}/${hash}`,
  and returns `res.arrayBuffer()`. No mime games, no object URL — pdf.js consumes the buffer.
- **PIN-STORAGE-1 note:** this fetch targets `/api/*`. It MUST NEVER be runtime-cached by
  the service worker (§6.3). The SW navigation denylist already excludes `/api/`; the new
  runtime-cache rule (§6.2) is scoped to first-party `/assets/*` chunks only, so the blob
  bytes are never written to Cache Storage. (Offline PDF *content* caching is a separate,
  deferred Dexie concern — §6.4.)
- **Transfer, not copy:** when handing the buffer to pdf.js, pass it so pdf.js can take
  ownership of the typed array — pdf.js copies into its worker via `postMessage` transfer
  internally; we hand it `{ data: new Uint8Array(buf) }`. Hold no second long-lived
  reference to the bytes (a 25 MB PDF buffer is the single largest allocation; release it
  once the `PDFDocumentProxy` is open).

---

## 3. The reader UI

`PdfReader` is the lazy component mounted in the `FileNoteView` preview region. It owns four
sub-surfaces. The layout is a **vertical reader** with an optional thumbnail rail and a
search bar; it must read well on mobile (single column, rail collapses to a drawer) and
desktop (rail docked left).

```
┌───────────────────────────────────────────────┐
│ toolbar: [≡ thumbs] [page 3 / 128 ▸jump] [🔍]  │   ← compact, sticky
├──────────┬────────────────────────────────────┤
│ thumb    │   ┌────────────────────────────┐    │
│ strip    │   │  page 2 (canvas + textlayer)│    │   ← scrollable viewport
│ (virt.)  │   └────────────────────────────┘    │
│ ▢ p1     │   ┌────────────────────────────┐    │
│ ▣ p2 ◀   │   │  page 3 (canvas + textlayer)│    │
│ ▢ p3     │   └────────────────────────────┘    │
│  …       │       … (windowed; §4) …            │
└──────────┴────────────────────────────────────┘
```

### 3.1 Scrollable multi-page viewer (Slice 1)

- A single vertically-scrolling viewport listing **all pages top-to-bottom**, each page a
  canvas sized to the page's intrinsic dimensions × the fit scale (fit-to-width by default;
  the long edge clamps so a wide page doesn't overflow).
- **Windowed (§4):** only pages near the viewport are actually rendered to canvas; the rest
  are **placeholder boxes of the correct height**, so the scrollbar, scroll position, and
  jump-to-page math are exact even though 99% of a 500-page PDF is never rasterized.
- Page count + a current-page indicator (derived from scroll position) live in the toolbar.
- Loading + error states: a spinner while `getDocument(...).promise` resolves; a clean
  inline error ("Couldn't open this PDF" + Download fallback) on parse failure — the reader
  **never** breaks `FileNoteView` (the Download/Delete chrome must still work).

### 3.2 Thumbnail strip (Slice 2)

- A **virtualized** rail of low-resolution page previews (small canvases, e.g. long edge
  ~120px, rendered at a low scale to keep memory + CPU tiny). Same windowing discipline as
  the main viewer — only thumbnails near the rail's scroll position render; off-screen ones
  are placeholder boxes.
- Tapping a thumbnail **scrolls the main viewer to that page** (shared jump path, §3.3). The
  current page's thumbnail is highlighted; the rail keeps it in view as the viewer scrolls.
- **Mobile:** the rail is **off by default** and opens as a drawer/overlay (the `≡ thumbs`
  toolbar button) to preserve reading width — flagged as an open UX question (§9 OQ-2).

### 3.3 Jump to page (Slice 2)

- A toolbar control: the `page N / total` indicator is an editable field (tap → type a page
  number → Enter) plus prev/next chevrons. Out-of-range input clamps to `[1, total]`.
- "Jump to page N" sets the scroll position to page N's placeholder offset (§4 keeps every
  page's offset known even when unrendered), which triggers the windowed renderer to
  rasterize N and its buffer. This is the **single shared jump primitive** used by jump-to-
  page, thumbnail taps, and search "jump to match" (§5).

### 3.4 Search bar (Slice 3)

- A toolbar-toggled search field: type a query → matches highlight across the document →
  `‹ 3 / 17 ›` match counter + prev/next to walk matches. Enter / next advances; each step
  **jumps the viewer to the page holding that match** (§3.3) and visually emphasizes the
  active match (e.g. a stronger highlight on the current hit).
- Matches are drawn as highlight rectangles over the **text layer** of the relevant page
  (§5). On mobile the search field anchors above the keyboard (mirror the editor's keyboard-
  anchored UI pattern); on desktop it docks in the toolbar.

---

## 4. Virtualization design (the core perf decision)

A 100s-of-pages PDF must **never** render all pages/canvases at once — memory and CPU would
blow the performance north-star (`performance-is-a-standing-value`). The reader windows
rendering for **both** the main viewer and the thumbnail rail.

### 4.1 Known geometry without rendering

- On open, after `pdf.getDocument(...).promise`, **fetch only each page's `viewport`
  dimensions** (`page.getViewport({ scale })` via `pdf.getPage(n)` is cheap — it reads the
  page dict, it does **not** rasterize). For very large PDFs, fetch viewports lazily/in
  batches but compute a running layout so the **total scroll height is known** (sum of
  per-page heights + gaps). Until a page's true height is known, use an estimate (the
  median of known pages) and reconcile as real dimensions arrive — the scrollbar may nudge
  slightly on a huge doc; acceptable, flagged (§9 OQ-3).
- Each page gets an absolutely/translate-positioned **placeholder** at its computed offset.
  This makes jump-to-page (§3.3) and the scroll→current-page readout exact.

### 4.2 The render window

- Maintain a window = **visible pages + a small buffer** (e.g. ±1–2 pages above/below the
  viewport). An `IntersectionObserver` (or a scroll-position computation against the known
  offsets) decides which page indices are "in window."
- **In window →** render the page to its canvas: `page.render({ canvasContext, viewport })`,
  cancel any in-flight render for that page first (`renderTask.cancel()` on a fast scroll to
  avoid piling up render tasks).
- **Out of window →** **destroy the canvas** (drop the bitmap: set width/height to 0, null
  the ref so the GC reclaims it) and revert to the placeholder box. Recycling/destroying
  off-screen canvases is what bounds memory regardless of page count.
- **DevicePixelRatio:** render at `scale × dpr` for crispness but **cap** the effective
  canvas pixel area (a hard ceiling, e.g. ~4M px/canvas) so a huge page on a retina screen
  can't allocate a runaway bitmap. Downscale via CSS to the layout size.

### 4.3 Thumbnail virtualization

- The rail uses the **same windowing**: only thumbnails near the rail viewport render, at a
  **low scale** (long edge ~120px). Off-screen thumbnail canvases are destroyed and replaced
  by placeholders. Thumbnails render at low priority — never block the main viewer's render
  of the page the user is actually reading (schedule them after, e.g. via `requestIdleCallback`
  or a simple priority queue).

### 4.4 One worker, bounded concurrency

- A **single** pdf.js worker per open document. Render requests (main pages + thumbnails)
  funnel through a small concurrency-limited queue so we never fan out 100 simultaneous
  renders. Visible main pages take priority over thumbnails over off-screen buffer.
- Tear down on unmount: cancel pending render tasks, `pdfDocument.destroy()`, terminate the
  worker, drop all canvases. (Mirrors `spellEngine.dispose()` discipline.) A leak here would
  accumulate across every PDF the user opens in a session.

---

## 5. Search design (needs the text layer)

Search requires extracting text per page (`page.getTextContent()`) and matching across the
document, then mapping matches back to on-page positions to highlight them.

### 5.1 The text layer

- For a rendered page, in addition to the canvas, build the **text layer**: positioned,
  **inert** text spans laid over the canvas at the glyph positions pdf.js reports
  (`TextContent.items` → the standard pdf.js text-layer rendering). It is *parse-not-
  execute*: the spans are plain text the browser lays out; **no** annotation layer, **no**
  link layer, **no** embedded-JS — strictly inert text. This is a slightly larger DOM
  surface than canvas-only but introduces **no active content** (§7 confirms the secSys
  posture). The text layer is what enables both browser-native selection/copy *and* search
  highlight rectangles.

### 5.2 The match index

- **Build a lightweight in-memory index on open**, lazily: extract `getTextContent()` per
  page into a normalized, lowercased page-text string (+ a map from char offsets back to the
  text items, so a match range can be turned into highlight rects). Extraction is cheap
  relative to rendering and runs **off the critical first-paint** — kick it off after the
  first visible page renders, page by page (idle-scheduled), so opening a PDF doesn't stall
  on indexing a 500-page doc. Search before the index finishes searches what's indexed so
  far + continues as pages complete (show an unobtrusive "indexing…" hint).
  - *Alternative considered:* pure extract-on-demand per search. Rejected as the default —
    re-extracting every page on every keystroke is wasteful and makes "N matches total"
    impossible until you've visited every page. The one-time lazy index is the right call;
    it's small (just normalized strings + offset maps), far smaller than the rendered
    bitmaps it coexists with.
- A query produces a flat, ordered list of **matches**: `{ pageIndex, charStart, charEnd }`.
  The match counter (`3 / 17`) is the length; "current match" is an index into it.

### 5.3 Highlighting + jump-to-match (interaction with virtualization)

- **Jump to match** uses the shared jump primitive (§3.3): scroll to the match's page → the
  windowed renderer rasterizes that page + builds its text layer → the match's char range is
  converted (via the offset map) to one or more **highlight rectangles** drawn over the text
  layer; the active match gets a stronger style.
- **The virtualization interaction is the subtle part:** a match's page may be **outside the
  render window** when selected. The flow must be: compute the page from the match (known
  without rendering, since the index is page-keyed) → jump/scroll → *await* that page entering
  the window and its text layer being ready → then paint the highlight. Highlight state is
  keyed by page index so that when a page scrolls out and back, its highlights re-derive
  (don't assume a highlight DOM node persists across a destroy/recreate). Non-active matches
  on currently-windowed pages also show their (lighter) highlight; matches on unrendered
  pages simply aren't painted until their page enters the window — correct and cheap.

---

## 6. Lazy-load + offline-cache (the SW wiring) — PIN-STORAGE-1 compliant

This is Jim's explicit architectural call and the part with the standing-audit constraint.

### 6.1 Lazy load — pdf.js never in first load

- `pdfjs-dist` and `PdfReader` load **only when the user first opens a PDF file note**:
  - `PdfReader` is imported **at a second level** via `import()` **inside** `FileNoteView`'s
    pdf branch — it is NOT static-imported, so it never enters `FileNoteView`'s static graph,
    and `FileNoteView` itself is already a lazy chunk off the entry bundle (`file-notes.md`
    §3.2). Net: pdf.js is two lazy hops from first load.
  - pdf.js's parser runs in its **own Web Worker** (`GlobalWorkerOptions.workerSrc` → the
    Vite-bundled, same-origin worker — §7), exactly like `spellEngine`'s worker. The heavy
    ~0.5 MB-gzipped worker is off the main thread and off the entry bundle.
- **Stable chunk naming so the SW can match it.** Configure Rollup so pdf.js lands in
  predictably-named chunks (Vite hashes filenames, so we pin a recognizable prefix):

  ```ts
  // vite.config.ts — build.rollupOptions.output
  manualChunks(id) { if (id.includes('pdfjs-dist')) return 'pdfjs'; },
  chunkFileNames: (info) => info.name === 'pdfjs'
    ? 'assets/pdfjs-[hash].js' : 'assets/[name]-[hash].js',
  ```

  The pdf.js **worker** asset (loaded via `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url))` or the dist worker entry) must likewise emit with a matchable name
  (e.g. an output `assetFileNames`/worker-chunk rule yielding `assets/pdf.worker-[hash].js`).
  The exact mechanism is the implementer's call; the **requirement** is: every pdf.js chunk's
  emitted filename matches a single stable glob — `**/pdfjs-*.js` **and** `**/pdf.worker*.js`
  under `/assets/`.

### 6.2 Runtime-cache the pdf.js chunks (so subsequent PDF views work offline)

- After first load, the pdf.js **app-asset chunks** must be **runtime-cached** so opening a
  PDF a second time (or offline) doesn't refetch them. Add a Workbox runtime route to
  `sw.ts`, modeled exactly on the existing `/fonts/` `CacheFirst` rule (line 38–41):

  ```ts
  // pdf.js engine chunks — runtime-cached so a second PDF open (incl. offline) needs no network for
  // the engine. FIRST-PARTY app assets (/assets/*.js), NEVER /api/* (pin-storage-1-sw-cache-invariant):
  // the match is scoped to the pdfjs chunk-name prefix only, so it can match neither the blob (/api/*)
  // nor unrelated assets. CacheFirst + no expiration = stored once, served forever across this deploy;
  // a new deploy hashes new filenames → new cache entries, old ones idle out (same as the fonts rule).
  registerRoute(
    ({ url }) =>
      url.origin === self.location.origin &&
      (/\/assets\/pdfjs-.*\.js$/.test(url.pathname) || /\/assets\/pdf\.worker.*\.js$/.test(url.pathname)),
    new CacheFirst({ cacheName: 'deltos-pdfjs' }),
  );
  ```

- **Do NOT precache them at install.** The injectManifest glob is currently
  `**/*.{js,css,html,svg,png,ico,webmanifest,woff2}` (vite.config.ts L53) — which would sweep
  the pdf.js chunks into the **install-time precache**, bloating install for every user
  including those who never open a PDF. Add a **`globIgnores`** to exclude them so they're
  runtime-cached-on-first-use, never install-precached:

  ```ts
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
    globIgnores: ['**/pdfjs-*.js', '**/pdf.worker*.js'],   // pdf.js = lazy + runtime-cached, NOT precached
  },
  ```

  This is the crux of Jim's "don't bloat install for users who never open a PDF" call:
  `globIgnores` keeps them out of the precache manifest, and the §6.2 runtime rule caches
  them the first time a PDF actually opens.

### 6.3 PIN-STORAGE-1 compliance — spelled out

The standing audit rule (`pin-storage-1-sw-cache-invariant`): **the service worker must
NEVER runtime-cache `/api/*` responses into Cache Storage.** Mapping it to this feature:

| Asset | URL | SW treatment | Why compliant |
|---|---|---|---|
| pdf.js engine chunks | `/assets/pdfjs-*.js`, `/assets/pdf.worker*.js` | **runtime-cached** (`CacheFirst`, §6.2) | first-party **app assets**, not `/api/*` — caching app JS is exactly the fonts-rule precedent. |
| The PDF blob bytes | `GET /api/plugin/blob/:hash` | **never cached** | matched by **no** runtime rule; the match predicate (§6.2) is scoped to the pdfjs chunk-name prefix, which an `/api/*` path can never satisfy. The navigation denylist (sw.ts L30) already keeps `/api/` off the shell. |

The runtime-cache predicate is written to match **only** the pdf.js asset chunks by name —
it can match neither the blob (`/api/…`) nor any other asset. There is **no** code path that
writes a `/api/*` response to Cache Storage. (A standing audit check: grep `sw.ts` on any SW
change to confirm no `/api` ever reaches a caching strategy — same invariant the fonts rule
already honors by scoping to `/fonts/`.)

### 6.4 Offline PDF *content* — DEFERRED (open question)

Caching the **actual PDF files** for offline reading **cannot** use the SW (the bytes come
from `/api/*`; PIN-STORAGE-1 forbids SW-caching them). It would require the **client local
store (Dexie)** — explicitly persisting selected PDFs' bytes in IndexedDB, account-scoped,
with its own eviction/quota policy. That is a **separate feature** with real surface area
(which PDFs, how much, eviction, account isolation). **Recommend deferring it.**

> **Scope of THIS spec:** *"the reader engine works offline; PDFs require network to fetch
> (then render fully in-app)."* Once the pdf.js chunks are runtime-cached (§6.2), opening a
> **previously-fetched-this-session** or **network-available** PDF works; a cold offline open
> of a never-fetched PDF shows a clean "offline — connect to load this PDF" state with the
> Download/Delete chrome intact. Flagged for Jim as OQ-1 (§9).

---

## 7. Security config (secSys gate)

The reader is *parse-not-execute*; the configuration below is what keeps it that way. It is
a **secSys gate** (PDF-S, §8).

- **Worker source:** `GlobalWorkerOptions.workerSrc` → the **Vite-bundled, same-origin**
  pdf.js worker (a hashed `/assets/pdf.worker-*.js`, served from our own origin). **Never** a
  CDN URL, never cross-origin — the worker is first-party, CSP-clean, SW-cacheable.
- **`isEvalSupported: false`** in the `getDocument` parameters — disable pdf.js's optional
  `eval`-based font/CMap fast path so the engine never calls `eval`/`Function` (CSP-friendly,
  removes a code-gen surface).
- **Scripting OFF — never opt in.** Do **not** pass `enableScripting: true`; do **not** load
  the `pdf.scripting`/`pdf.sandbox` module. The reader **never** executes embedded PDF
  JavaScript. (This is the default; the gate is that we *never flip it on*.)
- **No annotation/link interactivity:** render the **canvas + the inert text layer only**.
  Do **not** render the annotation layer / link layer (which can carry URL actions / JS
  actions). The text layer is positioned plain-text spans for selection + search highlight —
  **no active content**, no `href`s wired to PDF actions.
- **Network posture:** `disableAutoFetch: true` + `disableStream: true` (appropriate here —
  we hand pdf.js the **full ArrayBuffer** up front from the single authenticated GET, so
  there's no range-request streaming to do; this also guarantees pdf.js makes **no** network
  fetches of its own — all bytes come from our one authenticated fetch). Bundle the standard
  fonts / CMaps as same-origin assets (`cMapUrl`/`standardFontDataUrl` → bundled, not CDN) so
  the engine never reaches off-origin for resources.
- **Bytes provenance:** the PDF bytes only ever come from the **authenticated
  `GET /api/plugin/blob/:hash`** (BOLA-safe, own-prefix-only, `attachment` + `nosniff` +
  `default-src 'none'; sandbox` CSP — `blob.ts` §3). **No inline PDF route is added**; the
  blob is never served as active content. The worker boundary in `blob.ts` is untouched.
- **Net new active-content surface: none.** The text layer is inert text; the worker is
  first-party parse-only; scripting/annotations are off; bytes are octet-stream from the
  existing gated route. This preserves the closed XSS posture `blob.ts` was audited for.

---

## 8. Build slices (independently shippable)

Each slice ships green behind its own gates. The **perf north-star is binding**: pdf.js must
stay out of the entry bundle and out of `FileNoteView`'s static graph (PDF-P).

### Slice 1 — Lazy pdf.js + scrollable virtualized viewer + SW runtime-cache
The foundation. Add `pdfjs-dist`; the `loadBlobBytes` helper (§2.2); the `PdfReader` lazy
component with the **scrollable multi-page canvas viewer** (§3.1) on the **windowed
renderer** (§4); the Vite chunk-naming (§6.1) + the SW `globIgnores` and runtime-cache rule
(§6.2); the security config (§7). After this slice a PDF opens and reads end-to-end, one
column, no thumbnails/search yet.
**Gates:** PDF-1, PDF-2, PDF-P, PDF-S, PDF-OFFLINE, PDF-UI, PDF-SMOKE.

### Slice 2 — Thumbnail strip + jump-to-page
The **virtualized thumbnail rail** (§3.2, §4.3) + the **jump-to-page** control (§3.3) on the
shared jump primitive. Mobile = thumbnails as a drawer.
**Gates:** PDF-3, PDF-4, PDF-P (still holds), PDF-UI, PDF-SMOKE.

### Slice 3 — In-PDF text search
The **text layer** (§5.1), the lazy **match index** (§5.2), and **highlight + jump-to-match**
walking with virtualization-aware highlight (§5.3).
**Gates:** PDF-5, PDF-6, PDF-S (text layer stays inert), PDF-UI, PDF-SMOKE.

> Each slice is feel-testable on the live site (`review-on-live-never-local-preview`): Slice
> 1 = "I can read a whole PDF in-app"; Slice 2 = "I can navigate it"; Slice 3 = "I can find
> text in it." Ship Slice 1 first (the others build on its viewer + jump primitive).

---

## 9. Acceptance gates (PDF-*)

**Seam / data**
- **PDF-1** — Opening a `pdf`-type file note resolves to `FileNoteView` → the `PdfReader`
  branch (not the "No preview available" icon); a non-pdf file note is unchanged (image →
  image preview, other → icon). `isPdf` is mime-first with a `.pdf` extension fallback.
- **PDF-2** — `loadBlobBytes(hash)` returns the PDF's `ArrayBuffer` via the **existing**
  authenticated `GET /api/plugin/blob/:hash` (octet-stream + attachment) — **no new route,
  no inline serving, `blob.ts` untouched**. Throws cleanly on offline/miss → the reader shows
  an error state with Download/Delete chrome still working.

**Viewer / virtualization**
- **PDF-3** *(Slice 1 viewer; numbered after seam)* — A multi-page PDF renders all pages in a
  scrollable column; scroll position, total scroll height, and the current-page readout are
  correct. **A large PDF (100s of pages) does NOT allocate a canvas per page**: only the
  windowed pages (+buffer) have live canvases; off-screen pages are placeholders and their
  canvases are destroyed (verify bounded canvas count / memory while scrolling a big doc).
- **PDF-4** — Thumbnail strip is **virtualized** (only near-viewport thumbnails render, at
  low resolution; off-screen destroyed) and tapping a thumbnail jumps the viewer to that
  page. **Jump-to-page** N scrolls to page N (clamped to range) via the shared jump
  primitive. Thumbnails never starve the main page render.

**Search**
- **PDF-5** — Typing a query highlights matches across the document, shows an accurate
  `current / total` counter, and prev/next walks matches **including matches on pages outside
  the current render window** — selecting such a match jumps to its page, renders it, and
  paints the highlight once the text layer is ready.
- **PDF-6** — The match index is built lazily off the first-paint path (opening a large PDF
  is not stalled by indexing); highlight rectangles re-derive correctly when a page scrolls
  out of and back into the window (no stale/orphan highlight after a canvas destroy/recreate).

**Perf (north-star — blocking)**
- **PDF-P** — `pdfjs-dist`, `PdfReader`, and the pdf.js worker are **lazy chunks**: NOT in
  the entry bundle, NOT in `FileNoteView`'s static import graph (a second-level `import()`
  inside the pdf branch), and **NOT in the SW install precache** (`globIgnores` excludes
  them). Verify via the build's chunk graph + the generated precache manifest (the pdfjs
  chunks must be **absent** from it). Opening a notebook of non-pdf notes loads zero pdf.js
  bytes. Mirrors the `spellEngine` / `plugins-lazy-past-first-paint` lane.

**Security (secSys — blocking)**
- **PDF-S** — secSys-reviewed config (§7): `workerSrc` = bundled same-origin worker;
  `isEvalSupported:false`; `disableAutoFetch`/`disableStream` on (full-buffer feed → pdf.js
  makes **no** network fetches); **`enableScripting` never set / scripting module never
  loaded**; **no** annotation/link layer; the text layer is **inert text only** (no active
  content); fonts/CMaps bundled same-origin (no CDN). Bytes only ever from the authenticated
  blob GET; **no inline PDF route**; `blob.ts` safe-serving boundary untouched. Confirm pdf.js
  never reaches off-origin (network panel shows only the one `/api/plugin/blob/:hash` fetch +
  same-origin asset loads).

**Offline**
- **PDF-OFFLINE** — After a first PDF open (online), the pdf.js chunks are **runtime-cached**
  (`deltos-pdfjs` cache present); reloading and opening **another** PDF (network for the blob
  available, but engine offline-served) needs **no** network for the engine. The PDF **blob**
  (`/api/plugin/blob/:hash`) is **NEVER** found in any Cache Storage bucket (PIN-STORAGE-1).
  A cold **offline** open of a never-fetched PDF shows a clean offline state, not a crash.

**Mounted UI (standing gate) + live smoke**
- **PDF-UI** — Per `ui-features-need-rendered-ui-gate`: component/integration tests that
  **mount** `FileNoteView` with a pdf-type note (pdf.js stubbed/mocked at the worker seam)
  and assert the reader DOM — the page-canvas list, the thumbnail rail, the jump control, the
  search bar + match counter — actually render and wire to the jump primitive. Unit-green +
  worker-mock alone is not sufficient.
- **PDF-SMOKE** — Per `review-on-live-never-local-preview`: deploy to
  `deltos.blackgate.studio` and a thin on-device smoke — open a real multi-page PDF file
  note on the phone, scroll it, jump to a page, search a word, walk matches; confirm it reads
  smoothly (no jank on a big doc) and the engine is served from cache on a second open.

---

## 10. Implementation surface (file-by-file)

### Client
| File | Change |
|---|---|
| `packages/client/package.json` | add `pdfjs-dist` dependency. |
| `packages/client/src/plugins/attachment/blobClient.ts` | add `loadBlobBytes(hash): Promise<ArrayBuffer>` (§2.2) — bytes from the **existing** `GET /:hash`, session-cached by hash. |
| `packages/client/src/views/FileNoteView.tsx` | add the `isPdf(mime,name)` predicate + the pdf branch in the preview region → second-level `import()` of `PdfReader` (§2.1). Every other branch unchanged. |
| `packages/client/src/views/pdf/PdfReader.tsx` **(new)** | the lazy reader: scrollable windowed viewer (Slice 1), thumbnail rail + jump (Slice 2), search (Slice 3). Owns the pdf.js worker lifecycle (open/teardown). |
| `packages/client/src/views/pdf/pdfEngine.ts` **(new)** | the pdf.js handle: `getDocument` with the §7 security params, `GlobalWorkerOptions.workerSrc` wiring (bundled worker), the bounded render queue (§4.4), the lazy text index (§5.2). The `spellEngine`-analogue seam (mockable for PDF-UI). |
| `packages/client/src/views/pdf/*` | thumbnail rail, search bar, jump control sub-components + styles. |
| `packages/client/vite.config.ts` | `build.rollupOptions.output` manualChunks/chunkFileNames for the `pdfjs` + worker chunk names (§6.1); `injectManifest.globIgnores` to exclude the pdf.js chunks from precache (§6.2). |
| `packages/client/src/sw.ts` | the `deltos-pdfjs` `CacheFirst` runtime route scoped to the pdfjs chunk names (§6.2), modeled on the `/fonts/` rule. |

### Worker / Shared
**None.** No new route, no schema/migration, no binding, no shared change. The PDF bytes ride
the existing `GET /api/plugin/blob/:hash`; the file-note discriminator already exists.

---

## 11. Open questions

1. **Offline PDF *content* (§6.4)** — the reader *engine* works offline once cached, but the
   PDF *file* needs network to fetch (PIN-STORAGE-1 forbids SW-caching `/api/*` bytes).
   Offline reading of specific PDFs would need a **Dexie** PDF-bytes store (account-scoped,
   with eviction/quota). **Recommend deferring** to a later feature; confirm with Jim that
   "engine offline, content needs network" is acceptable for v1.
2. **Mobile thumbnail UX (§3.2)** — rail-as-drawer vs a bottom filmstrip vs no thumbnails on
   mobile (jump-to-page may be enough on a small screen). Recommend drawer; confirm on
   device.
3. **Very-large-PDF limits (§4.1)** — a 1000+ page or very heavy PDF: scroll-height estimate
   reconciliation, index build time, and the 25 MB blob cap (PDFs above it can't be uploaded
   at all today). Do we need a page-count or size guard / a "this PDF is large" affordance?
   Probably fine within the 25 MB cap; revisit if a real doc janks.
4. **Render scale / zoom** — v1 is fit-to-width only. Pinch-zoom / a zoom control is a
   natural follow-up (re-render at a higher scale within the canvas-pixel cap). Out of v1
   unless Jim wants it; flag.
5. **Text selection / copy** — the text layer enables native selection for free. Confirm we
   *want* selectable text (almost certainly yes) vs search-highlight-only. Recommend keeping
   selection (it's the same inert text layer, no extra surface).
</content>
</invoke>
