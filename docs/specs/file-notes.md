# File Notes — Design + Build Spec

**Status:** DESIGN → BUILD-READY (settled by Jim 2026-06-28). This is the done-gate
for the build that follows.
**Date:** 2026-06-28.
**Depends on:** the attachment plugin + `blob` host capability (BUILT, secSys-audited,
live on `main`). See `plugin-support.md` §1A (block AND note-type shapes), §7 (`blob`
capability), §10.2 (attachment as first consumer). The file note is the **note-type**
sibling of the attachment **block** — same R2 blob / content-addressing underneath.
**New infra:** exactly one binding — Cloudflare Workers **Images** (`env.IMAGES`).
**Zero schema / migration / sync-protocol change.**

---

## 0. The one-line thesis

A **file note** is the attachment block **promoted to be the whole note** — a foreign
artifact (pdf / docx / image / `.blend` / …) that *lives inside* the deltos UI but is
**not a native deltos document**. It is a normal synced note whose `title` is the
filename, whose `properties` carry a `fileType:file` discriminator, and whose `body` is a
single attachment `plugin_block` pointing at an R2 blob. It reuses the already-built
blob pipeline wholesale; the only genuinely new piece is in-Worker image transformation
(`env.IMAGES`) for thumbnails and on-download JPEG. Per `plugin-support.md` §1A this is
the **note-type** shape of the same `file` entity whose **block** shape already ships —
*"Same R2 blob / content-addressing underneath. … the entity data/logic is defined ONCE;
the difference is purely which surfaces are exposed."*

It is deliberately **not** the ProseMirror editor: the whole note IS the artifact, so a
rich editor would be wrong (`plugin-support.md` §1A REFRAME). It resolves to a bespoke
`FileNoteView` through the existing `resolveNoteView` seam.

---

## 1. What a file note IS (and is not)

- **IS:** a synced note that *wraps* a foreign file. List row = an artifact pill. Open =
  a viewer (preview-if-able + Download / Delete / Rename + metadata). The bytes live in
  R2 (private, content-addressed, account-scoped) exactly as an attachment block's do.
- **IS NOT:** a deltos doc. No title/body editing as prose, no `/` palette, no blocks to
  compose. The body holds one machine-authored attachment block and nothing else.
- **Relationship to the attachment BLOCK:** the block embeds a file *mid-document*; the
  file note is the file *as the document*. Both register around the `file` entity; both
  use `blobClient` + the `/api/plugin/blob` route. The note-type adds: a `fileType`
  discriminator, a `registerNoteView` viewer, and a new-note creation flow (drag-drop) —
  per `plugin-support.md` §1A "what note-types ADD beyond blocks."

---

## 2. Data model — zero migration

A file note is a `Note` (`packages/shared/src/spine/note.ts`) with **no new fields**. The
three spine layers carry it:

| Layer | Value for a file note |
|---|---|
| `title` | the original **filename** (e.g. `Q3-report.pdf`). User-renamable. |
| `properties` | carries the **`fileType` discriminator** (see encoding below). |
| `body` | a **single `plugin_block`** node, `pluginType: 'attachment'`, `pluginContent: { hash, name, mime, size }`. No other blocks. |

**The blob** already lives in R2 at key `{accountId}/{hash}` (server-derived accountId,
server-computed hash — `routes/blob.ts`). Nothing about storage changes.

### 2.1 The `fileType` discriminator — precise encoding

`plugin-support.md` §1A calls for *"a `type` (item-view) discriminator in the note's
`properties` bag; `registerNoteView` keys on it → deterministic resolution, not
content-sniffing."* The property bag is a **typed discriminated-union** map
(`spine/property.ts`) — a `Record<string, PropertyValue>` whose values are a union
**discriminated on a `type` field**. To avoid colliding with that `PropertyValue.type`
discriminant (and to avoid squatting on the bare, generic user key `type`), the note-type
discriminator is a property **key** named **`fileType`** whose **value** is a `text`
property:

```ts
note.properties['fileType'] = { type: 'text', value: 'file' };
```

> **Marker, not format.** The *presence* of the `fileType` key (with value `'file'`) is
> the note-type discriminator — `'file'` is a simple marker string, **not** the file's
> format. The actual file FORMAT (pdf / image / `.blend` / …) is derived from the
> attachment block's `mime` / `name`, never from this key. Resolution reads
> `properties.fileType?.value === 'file'`. Provide a tiny shared helper
> `isFileNote(note): boolean` (in `@deltos/shared`, next to the spine) so the predicate is
> defined once and both the list branch and the view predicate import it — never two
> ad-hoc reads that can drift (cf. the `isTrashed` single-source pattern in
> `reservedKeys.ts`). Mirror that file's writer shape with a `setFileType(bag)` marker-
> writer for the creation path (the analogue of `setTrashedAt`).

`fileType` is deliberately a **user-authored-namespace** key (no `sys:` prefix), so it is
NOT a reserved system key. This is intentional: `userProperties()` (the
`reservedKeys.ts` chokepoint) strips only `sys:`-prefixed keys, so a non-`sys:`
`fileType` **survives duplication** — duplicating a file note preserves its
file-note-ness, which is exactly what we want. It also round-trips as ordinary
frontmatter and is visible to a future property editor; that is acceptable — it is genuine
note metadata, not hidden machinery. (Contrast the trash flag, which IS `sys:`-namespaced
precisely so it is stripped from exports/duplicates.)

### 2.2 Round-trip through existing sync

Because a file note is a plain `Note`, it rides **every existing path with zero change**:
`mutateNotes.put` → `putNoteAndEnqueue` → the `upsert` push; pull-merge; conflict-as-
version; trash (`softDelete` sets `sys:trashedAt`); duplicate; search (title +
properties). The `plugin_block` body already has opaque round-trip + unknown-type
fallback (`plugin-support.md` §11). **No migration file. No wire change. No new op.**

---

## 3. Render surfaces

A file note appears on two surfaces. Both branch on `isFileNote(note)`.

### 3.1 LIST row — the artifact pill

In `HomeView` (`App.tsx`, the `notes.map(...)` row render, ~L212), branch:

- **default note** → the existing title + meta + preview row (unchanged).
- **file note** (`isFileNote(note)`) → an **artifact pill**: visually more pill-like /
  card-like than a text row (it represents an object, not a line of prose). The pill
  shows a **leading visual** + the filename + a faint size/type meta line. It is still a
  `<Link to={/note/:id}>` wrapped in the existing `SwipeRow` (swipe-delete / duplicate /
  move all keep working — they operate on the `Note`, not its kind).

**Leading visual — two cases:**

| File kind | Leading visual |
|---|---|
| **Image** (`png`, `jpeg`, `webp`, `heic`) | a small **square WebP thumbnail tile**, pre-baked at upload (§4). Painted from a plain authenticated `R2.get` of `{hash}.thumb.webp` → object URL — **no per-render transform**. |
| **Everything else** | a **format icon** resolved extension-first (below). |

**Extension → icon resolution (extension-first, mime fallback):**

1. Take the lowercased extension of `title` (or `pluginContent.name`).
2. Look it up in a static `EXT_ICON` map: `pdf → FilePdf`, `doc/docx → FileDoc`,
   `xls/xlsx → FileSheet`, `ppt/pptx → FileSlides`, `zip/tar/gz → FileArchive`,
   `blend → Blender` (the Blender logo), `mp4/mov/webm → FileVideo`, … (extend freely).
3. **Fallback by mime class** when the extension is unknown: `image/* → Image` (the
   existing icon — used only when an image somehow lacks a thumbnail), `video/* →
   FileVideo`, `audio/* → FileAudio`, else a generic `FileGeneric` document glyph.

New glyphs are added to `icons/index.tsx` following the existing hand-rolled inline-SVG
convention (24×24 grid, `currentColor`, fine-line; the `Image` icon at L302 is the
template). The resolver itself (`resolveFileIcon(name, mime): ComponentType<IconProps>`)
lives alongside the icon registry.

**Perf:** the list branch is a cheap predicate + (for images) a session-cached object-URL
fetch that fires only for file-note rows actually in the list. It introduces **no new
work on the first-paint critical path** for text-only notebooks. The thumbnail fetch
helper is small and may live in the existing `blobClient` (already lazy-loaded only on the
edit/fetch path) — see §4.4.

### 3.2 OPEN — the `FileNoteView`

A **new** `FileNoteView` component, registered against the existing seam in
`editor/views.ts`:

```ts
export interface NoteViewDescriptor {
  readonly key: string;
  matches(note: Note): boolean;
  component: ComponentType<NoteEditorProps>;   // { note, onSave, autoFocus? }
}
export function registerNoteView(descriptor: NoteViewDescriptor): void;
export function resolveNoteView(note, fallback): ComponentType<NoteEditorProps>;
```

`NoteRoute.tsx` (L197) already does `resolveNoteView(note, NoteEditor)` and renders the
result with `<ViewComponent note={note} onSave={handleSave} autoFocus={isNew} />`. So the
wiring is: **register a descriptor whose `matches` is `isFileNote`, whose `component` is
`FileNoteView`.** The block editor stays the unconditional fallback. `FileNoteView`
satisfies `NoteEditorProps` but ignores `autoFocus` and uses `onSave` only for **Rename**
(a `title` write).

**Layout (top→bottom):**

1. **Header** — filename (the title; doubles as the Rename target), size + type meta.
2. **Preview-if-able:**
   - **Image** (`png/jpeg/webp/heic`) → render the pre-baked **full-view** WebP derivative
     (`{hash}.view.webp`, §4) inline (`<img>` from an object URL; HEIC is shown via its
     WebP derivative, never the raw HEIC bytes — browsers can't decode HEIC). This is the
     full-size, contain-fit derivative — distinct from the small square `{hash}.thumb.webp`
     tile the list paints.
   - **Everything else** → the large format icon (no inline preview). PDFs/Office docs
     are **not** inline-previewed: the blob route serves them `octet-stream` +
     `Content-Disposition: attachment` for safe-serving (`routes/blob.ts` §3), so an
     inline `<iframe>`/`<embed>` is out by security design. Icon + Download is the path.
3. **Actions** — **Download**, **Delete**, **Rename**.
   - **Download** → §4.3 (image → on-the-fly JPEG; other → raw bytes via the existing
     `downloadBlob`).
   - **Delete** → soft-delete the note (§6); navigates back to the list.
   - **Rename** → edit `title`; persist via the `onSave` prop (a normal note upsert).
4. **Metadata** — filename, mime, human size, created/updated, sync status.

**Lazy-loaded:** `FileNoteView` (and its registration module) is a **dynamic chunk**, not
static-imported into the entry/editor bundle — it is only needed when a file note is
opened. This honors the perf north-star (`plugins-lazy-past-first-paint`): the viewer
never ships in first-load. Registration mirrors the attachment runtime's lazy pattern —
either registered on first file-note open, or via a tiny eager descriptor whose
`component` is a `lazy()` wrapper. (Implementer's call; the eager-descriptor-with-lazy-
component path keeps `resolveNoteView` synchronous, which the seam requires.)

---

## 4. Image pipeline — `env.IMAGES`

**RESEARCHED + DECIDED (Jim):** use the **Cloudflare Workers Images binding** —
`env.IMAGES.input(r2Body).transform({ width, height, fit: 'cover' }).output({ format })`.
It is the **only** path that transforms **private** R2 bytes **in-Worker** (no public URL,
no zone config, no dashboard image-resizing enablement). This is the `compute` capability
of `plugin-support.md` §7 ("HEIC/JPEG/PNG↔WebP") realized for the first time.

### 4.1 The binding

Add to `packages/worker/wrangler.jsonc` (the `deltos-blobs` R2 bucket + `BLOBS` binding
already exist):

```jsonc
"images": { "binding": "IMAGES" },
```

- **Input cap:** the binding accepts inputs **≤ 20 MB**. (The blob route's own cap is
  25 MB — see §4.5 mismatch note.)
- **Valid output formats:** `jpeg`, `webp`, `avif` only. **PNG is NOT a valid output
  format** — never request it.
- **HEIC decode** works on **all plans** (input side). **Verify once** at build via
  `env.IMAGES.info(heicBody)` (an acceptance gate, FN-W4).
- **Local dev:** the binding has no local implementation — `wrangler dev --remote` is
  required to exercise it (same constraint as the `AI` binding). Note this in the route's
  comment.
- **Cost:** ~$0/mo at single-user volume (5000 free transforms/mo on the plan). The
  pre-bake design (§4.2) caps it at **2 transforms per image for life** (thumbnail + full
  view) — still vastly under the 5000/mo free allowance, and every render thereafter is a
  zero-transform `R2.get`.

### 4.2 Upload-time WebP pre-bake (two derivatives, in-app)

When a file note is **created from an image** (and for an attachment-block image upload —
shared path), after the blob is stored, **pre-bake TWO WebP derivatives** (settled by Jim,
resolving OQ-3 against the earlier "1 transform for life" sketch):

1. **Thumbnail** — `{accountId}/{hash}.thumb.webp` — a **small square crop** for the list
   artifact-pill tile: `env.IMAGES.input(body).transform({ width: 256, height: 256, fit:
   'cover' }).output({ format: 'webp' })` (center-crop to a retina-safe **256×256** square).
2. **Full view** — `{accountId}/{hash}.view.webp` — a **full-size, uncropped** WebP for
   the in-app `FileNoteView` preview: `env.IMAGES.input(body).transform({ width: 2048,
   height: 2048, fit: 'scale-down' }).output({ format: 'webp' })`. `scale-down`/contain
   caps the **long edge at 2048px** without cropping and **never upscales** — an image
   already smaller than 2048px keeps its original dimensions.

- **Two transforms per image, ever.** Thereafter every list paint (`.thumb.webp`) and
  open-view preview (`.view.webp`) is a plain `R2.get` of the relevant derivative —
  **zero per-render transform** (the settled design; preserves the perf north-star).
- WebP is the **in-app** format (thumbnail tile + open-view preview). It is in the blob
  route's `SAFE_INLINE_TYPES`, so both derivatives can be served with their real
  `image/webp` type.

**Where it hooks in:** the blob upload route (`routes/blob.ts`, `POST /`) is the natural
home — after the `BLOBS.put`, if the mime is an image type, derive + store **both** the
`.thumb` and the `.view`. Two sub-options (implementer's call, flag in PR):
- **(a) inline in the upload request** — simplest; adds the (two) transform latencies to
  upload.
- **(b) a dedicated `POST /api/plugin/blob/:hash/thumb`** (deriving both) the client calls
  after upload, or a `waitUntil` background derive — keeps upload latency flat.
Either way each derive is **idempotent** (content-addressed key) and **non-fatal** (a
failed derive must not fail the upload; the list falls back to the format icon and the
open view to the large icon / no preview).

### 4.3 JPEG on download / export (on-the-fly + cache)

When the user **downloads/exports** an image file note:

- Transcode to **JPEG** on the fly: `env.IMAGES.input(original).output({ format: 'jpeg'
  })` (covers `heic → jpeg`, `webp → jpeg` — a universally-openable artifact off-device).
- Wrap in the **Workers Cache API**, keyed on the **immutable content hash** (the hash is
  a perfect, stable cache key) so a repeat download is a cache hit, **zero re-transform**.
- **JPEG is download-only.** In-app stays WebP. (Non-image files download their **raw
  bytes** unchanged via the existing `downloadBlob` — no transcode.)

### 4.4 Client fetch helpers

Add two thin helpers to `blobClient.ts` (siblings of `loadBlobUrl`), both **session-cached**
by hash (reuse the existing `urlCache` pattern):
- `loadThumbUrl(hash)` — fetches `{hash}.thumb.webp` (the square list tile).
- `loadViewUrl(hash)` — fetches `{hash}.view.webp` (the full-view `FileNoteView` preview).

Both WebP derivatives are safe to inline (they're in `SAFE_IMAGE_TYPES`). Serving them
needs an **inline** response (real `image/webp`, `nosniff`), distinct from the existing
`GET /:hash` which forces `Content-Disposition: attachment` — so add a sibling route that
returns a derivative inline, parameterized over the variant (e.g. `GET
/api/plugin/blob/:hash/thumb` and `GET /api/plugin/blob/:hash/view`, or one route with a
`?variant=thumb|view`). **secSys reviews this inline-serving route** (it is the one place
blob bytes are served non-attachment — but only ever the host-generated WebP derivatives,
never user-uploaded bytes, so the active-content XSS surface stays closed).

### 4.5 Caps to reconcile

- Blob route per-object cap = **25 MB** (`MAX_BLOB_SIZE`); IMAGES input cap = **20 MB**.
  → For **images > 20 MB**, skip the pre-bake (store the original, fall back to the format
  icon / no preview) rather than error. The note still works; only the thumbnail is
  absent. (Flag in §10 whether to clamp image uploads to 20 MB instead.)

---

## 5. Creation flows

### 5.1 Desktop — drag-drop onto the notes-list pane (settled)

The **mirror** of editor-drop = inline block. Dropping a file on the **notes-list pane**
(not inside an open editor) **creates a file note** and **stays on the list**:

- New module **`lib/dnd/fileNoteDnd.ts`** (sibling of the existing `noteDnd.ts`), a
  **lazy desktop-only chunk** loaded via the `useNoteDnd`-style hook pattern
  (`useFileNoteDnd(isDesktop)` → dynamic `import()`), so it **never ships to mobile or
  first-load**. It wires `dragover`/`drop` handlers on the list container in `HomeView`.
- On drop with `dataTransfer.files`: for each file call **`createFileNote(file)`**.
- The list stays put (no navigation) — the new pill animates in via the reactive
  `observeNotes` query. (Optionally select/open the new note; default = stay on list.)

**`createFileNote(file)` in `db/mutate.ts`** (new method on `mutateNotes`):

1. `const { hash, size } = await uploadBlob(file)` (existing `blobClient`).
2. Mint a `Note`: `id = newNoteId()`, `notebookId = current/default`, `title = file.name`,
   `properties = setFileType({}) // → { fileType: { type: 'text', value: 'file' } }`,
   `body = [ plugin_block{
   pluginType:'attachment', pluginContent:{ hash, name:file.name, mime:file.type, size } }
   ]`, fresh timestamps, `version = UNSYNCED_VERSION`, `syncStatus:'local-only'`,
   `accountId`. (Same minting shape as `NewNote.tsx`, plus the file body/properties.)
3. `await putNoteAndEnqueue(note, …)` (atomic note + sync entry, like the other mutators).
4. Return the new note (for an optional toast / selection).

Upload-failure handling: mirror the attachment block's error path — either surface a
toast and abort (no orphan note), or create the note in an error state. Recommend
**abort + toast** (a file note with no blob is useless). (Flag in §10.)

### 5.2 Mobile — TBD (explicit open item)

**Not settled.** Likely: the **"+" / new-note menu** gains a "File" entry → native file
picker (`<input type="file">`), then the same `createFileNote` path. **Share-sheet
ingest** (share a file from another app → deltos) is a **later** addition (needs the PWA
share-target manifest + a receiving route). Called out in §10; **not in the first build.**

---

## 6. Delete semantics

**Settled (Jim): delete = soft-delete the NOTE; leave the blob + both WebP derivatives
for later orphan-GC.**

- Delete (from `FileNoteView` or list swipe) calls **`mutateNotes.softDelete(note)`** —
  the *exact* existing trash path (`sys:trashedAt`, undoable, synced, recoverable from the
  Trash view). No special-casing.
- The R2 blob (`{accountId}/{hash}`) and its `{hash}.thumb.webp` + `{hash}.view.webp`
  derivatives are **left in place**. There is **no refcount today** (an attachment block and a file note can share a
  hash; content-addressing dedups). Reclaiming orphaned blobs is a **deferred orphan-GC
  sweep** (a later background job that lists R2 keys with no referencing live note).
- Consistent with `pre-real-users-clean-state-bias`: storage is cheap and disposable;
  don't build refcount/GC machinery before it's needed. Flagged in §10.

---

## 7. Implementation surface (file-by-file)

### Worker

| File | Change |
|---|---|
| `packages/worker/wrangler.jsonc` | add `"images": { "binding": "IMAGES" }`. |
| `packages/worker/src/routes/blob.ts` | (a) on image upload, pre-bake **both** `{hash}.thumb.webp` (256² cover) and `{hash}.view.webp` (≤2048px scale-down) via `env.IMAGES` (§4.2); (b) new `GET /:hash/thumb` + `GET /:hash/view` serving the WebP derivatives **inline** (`image/webp` + `nosniff`, §4.4); (c) on download-as-jpeg, transcode + Cache API (§4.3). |
| `packages/worker/src/context.ts` (env type) | add `IMAGES: ImagesBinding` to the env. |

### Client

| File | Change |
|---|---|
| `packages/client/src/App.tsx` (`HomeView`) | LIST branch: `isFileNote(note)` → artifact pill (thumbnail tile vs format icon); attach the desktop list drop zone via `useFileNoteDnd`. |
| `packages/client/src/lib/dnd/fileNoteDnd.ts` **(new)** | desktop-only lazy chunk: list `dragover`/`drop` → `createFileNote`. |
| `packages/client/src/lib/dnd/useFileNoteDnd.ts` **(new)** | the `useNoteDnd`-style lazy loader hook. |
| `packages/client/src/db/mutate.ts` | add `createFileNote(file)` (§5.1). |
| `packages/client/src/plugins/attachment/blobClient.ts` | add `loadThumbUrl(hash)` (square list tile) + `loadViewUrl(hash)` (full-view preview) — both session-cached WebP object URLs. |
| `packages/client/src/icons/index.tsx` | new format glyphs (`FilePdf`, `FileDoc`, `FileSheet`, `FileSlides`, `FileVideo`, `FileAudio`, `FileArchive`, `FileGeneric`, `Blender`) + `resolveFileIcon(name, mime)`. |
| `packages/client/src/views/FileNoteView.tsx` **(new)** | the open viewer (§3.2). Lazy chunk. |
| `packages/client/src/views/registerFileNoteView.ts` **(new)** | `registerNoteView({ key:'file', matches:isFileNote, component: lazy(FileNoteView) })`. Imported once at app init. |
| `packages/client/src/styles*` | the artifact-pill styles + `FileNoteView` layout. |

### Shared

| File | Change |
|---|---|
| `packages/shared/src/spine/` (+ index export) | `isFileNote(note)` predicate (reads `properties.fileType?.value === 'file'`) + a `FILE_NOTE_TYPE = 'file'` constant + a `setFileType(bag)` marker-writer (the `setTrashedAt` analogue, used by the creation path). Single source for the list branch AND the view predicate. |

---

## 8. Build slices (independently shippable)

Lead with the Worker IMAGES foundation; each slice ships green with its own gates. The
**perf north-star is binding**: the main list render + mobile first-load must not regress
— file-note rendering/creation stays **off the first-load critical path** (lazy chunks;
list branch is a cheap predicate; thumbnails paint from plain `R2.get`).

### Slice 0 — Shared discriminator (tiny foundation)
`isFileNote` / `FILE_NOTE_TYPE` / `setFileType` in `@deltos/shared`, unit-tested.
Everything else imports these. **Gate:** FN-1.

### Slice 1 — Worker IMAGES binding + dual WebP pre-bake (the foundation)
Add the binding; on image upload pre-bake **both** derivatives — `{hash}.thumb.webp`
(256² `cover`) and `{hash}.view.webp` (≤2048px `scale-down`); serve them inline via `GET
/:hash/thumb` + `GET /:hash/view`; `env.IMAGES.info` HEIC-decode verification. Tested
against **real Workers** (`wrangler dev --remote`) since the binding has no local impl.
**Gates:** FN-W1..W4.

### Slice 2 — `createFileNote` + desktop drag-drop creation
`createFileNote` in `mutate.ts`; `fileNoteDnd.ts` + `useFileNoteDnd`; wire the list drop
zone. A file note exists, syncs, opens (initially via the fallback editor until Slice 4).
**Gates:** FN-2, FN-3, FN-8 (lazy/perf).

### Slice 3 — List artifact pill (icons + thumbnail tile)
The `HomeView` list branch; `resolveFileIcon` + new glyphs; `loadThumbUrl` thumbnail tile;
pill styles. **Gates:** FN-4, FN-5, FN-8.

### Slice 4 — `FileNoteView` + registration (the open surface)
The viewer (preview / Download / Delete / Rename / metadata) + `registerNoteView`. JPEG-
on-download + Cache API. **Gates:** FN-6, FN-7, FN-W5.

> Slices 2–4 are each shippable: after Slice 2 a file note is real and opens (in the
> fallback editor — ugly but functional); Slice 3 makes the list right; Slice 4 makes the
> open-view right. Slice 1 is the only one that can't be feel-tested alone (no UI), so it
> ships behind the others but **lands first** (they depend on the thumbnail route).

---

## 9. Acceptance checklist

**Data / shared**
- **FN-1** — `isFileNote(note)` is true iff `properties.fileType` is a `text` value
  `'file'`; false for every normal note; one shared definition used by both list + view. A
  file note round-trips through `mutateNotes.put` → sync → pull with body + properties
  intact (no migration; no wire change). Duplicating a file note preserves `fileType` (it
  is user-namespace, so `userProperties()` does not strip it) → the copy is still a file
  note.

**Creation**
- **FN-2** — `createFileNote(file)` uploads the blob (existing `uploadBlob`) and mints a
  note with the §2 shape, atomically enqueued (note + sync entry in one txn).
- **FN-3** — Dropping a file on the desktop notes-list pane creates a file note and stays
  on the list; the new pill appears reactively. Drop **inside an open editor** still makes
  an inline attachment block (no regression to `attachmentDrop`).

**List surface**
- **FN-4** — A non-image file note renders an artifact pill with the correct **extension-
  first** format icon (`pdf`, `doc`, `blend → Blender`, …; unknown ext → mime-class
  fallback → generic).
- **FN-5** — An image file note renders a square WebP **thumbnail tile** from
  `{hash}.thumb.webp` via a plain authenticated `R2.get` — **no per-render transform**;
  session-cached.

**Open surface**
- **FN-6** — Opening a file note resolves to `FileNoteView` (not the PM editor), showing
  preview-if-able + Download + Delete + Rename + metadata. For an image, the inline preview
  paints from the **full-view** derivative `{hash}.view.webp` via a plain `R2.get` (NOT the
  square `.thumb`, and **no per-render transform**). A normal note still resolves to the
  editor.
- **FN-7** — Rename edits `title` (persisted as a normal upsert); Download yields a usable
  artifact (image → JPEG; other → raw bytes); Delete soft-deletes the note (Trash-
  recoverable) and leaves the blob + thumb in R2.

**Image pipeline (Worker)**
- **FN-W1** — `IMAGES` binding present; route degrades cleanly (icon, no preview) if
  unbound.
- **FN-W2** — On image upload, **both** WebP derivatives are stored: `{hash}.thumb.webp`
  (256² `cover` square crop) **and** `{hash}.view.webp` (≤2048px `scale-down`, uncropped,
  no upscale). Each is idempotent on re-upload (content-addressed key); a derive failure
  does **not** fail the upload (list falls back to the format icon, open view to the large
  icon / no preview).
- **FN-W3** — Download-as-JPEG transcodes via `env.IMAGES` and is Cache-API-cached on the
  content hash (repeat download = cache hit, no re-transform). PNG is **never** requested
  as an output format.
- **FN-W4** — `env.IMAGES.info` confirms HEIC decode on the live plan (verified once).
- **FN-W5** — `GET /:hash/thumb` **and** `GET /:hash/view` each serve their WebP
  derivative **inline** (`image/webp` + `nosniff`), are BOLA-safe (own-prefix only), and
  are secSys-reviewed. Never serve user-uploaded bytes inline — only the host-generated
  derivatives.

**Perf (north-star — blocking)**
- **FN-8** — `FileNoteView`, its registration, and `fileNoteDnd` are **lazy chunks**, not
  in the entry/editor bundle or shipped to mobile first-load. The list-row file branch
  adds no measurable cost to a text-only notebook's first paint. (Mirror the §11
  inventory's lazy-chunk gate; confirm via the build's chunk graph.)

---

## 10. Open questions

1. **Mobile creation (§5.2)** — confirm "+" menu → native file picker as the v1 mobile
   path; defer share-sheet ingest (PWA share-target). **Not in the first build.**
2. **Orphan-blob GC (§6)** — soft-delete intentionally leaves blob + thumb. When (and
   how) does the deferred orphan-GC sweep run? No refcount exists; a future job lists R2
   keys with no live referencing note. Deferred per `pre-real-users-clean-state-bias`.
3. **One derivative vs two (§4.2)** — **RESOLVED (Jim): two derivatives.** Pre-bake a
   small square `{hash}.thumb.webp` (256² `cover`) for the list tile **and** a full-size
   `{hash}.view.webp` (≤2048px `scale-down`) for the open preview. Two transforms/image for
   life is still ~$0/mo (well under 5000 free/mo), and each surface paints its
   right-sized derivative via a zero-transform `R2.get`. The earlier "1 transform for life"
   sketch is superseded.
4. **20 MB IMAGES cap vs 25 MB blob cap (§4.5)** — for images 20–25 MB: store original +
   skip pre-bake (no thumbnail), or clamp image uploads to 20 MB? Recommend the former
   (the note still works).
5. **Upload-failure on create (§5.1)** — abort + toast (no orphan note) vs create-in-
   error-state. Recommend abort.
6. **Discriminator key name + namespace (§2.1)** — **RESOLVED (Jim): key = `fileType`,
   user-namespace.** Named `fileType` (not the bare `type`) to avoid colliding with the
   `PropertyValue.type` discriminant and squatting on the generic user key `type`. Kept in
   the user namespace (no `sys:` prefix) **on purpose**: `userProperties()` strips only
   `sys:` keys, so `fileType` survives duplication (a duplicated file note stays a file
   note) and survives export (a file note's type *should* round-trip). It surfacing in a
   future property editor is acceptable — it is genuine metadata, not hidden machinery.
7. **PDF/Office inline preview** — out of v1 by safe-serving design (octet-stream +
   attachment). If inline PDF preview is later wanted, it needs a separate sandboxed-
   rendering decision (secSys). Icon + Download for now.
