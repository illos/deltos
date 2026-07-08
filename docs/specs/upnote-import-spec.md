# UpNote → deltos import spec

**Status:** draft · 2026-07-08
**Route:** a Claude agent on Jim's Mac reads the UpNote export + fetches images from UpNote's
local server, prepares an **import bundle**, then drives the **deltos MCP** to move the data in.
**Author:** lead (Fable) · grounded in the code, file:line cited throughout.

---

## 0. TL;DR — the headline (read this first)

The desktop-app + deltos-MCP route works for note **text/titles/filing**, but the current MCP
**cannot do two things this import needs**, so they are **prerequisite worker work**:

1. **No `create_notebook` tool.** `create_note` can only file into an *existing* notebook
   (`tools.ts:341` takes a `notebookId` from `list_notebooks`; there is no notebook-create tool).
   The import must recreate ~9 UpNote notebooks → we need a `create_notebook` MCP tool.
2. **No image / file path.** `create_note` / `update_note` / `append_block` accept **markdown text
   only** → `markdownToBody()` (`tools.ts:367,414,448`). deltos images are **attachment blocks**
   (`attachmentBlock.ts:40` → `{ hash, name, mime, size }`) that reference an **R2 blob by
   content-hash**. There is **no MCP tool** to upload bytes to R2 or to place an attachment block in
   a note. So "images as first-class R2 artifacts" — the whole point — is impossible via MCP today.

**Everything else is ready:** the R2 plumbing (`storeBlob` `blobStore.ts:126`, image-derivative bake
`bakeImageDerivatives` `blobStore.ts:82`, upload route `POST /api/plugin/blob` `blob.ts`), the
attachment-block model, and the notebook mutator all exist. The two new MCP tools are thin wrappers
over them. **§4 specs both.** With them, the route is clean end-to-end.

---

## 1. Source format — what the UpNote export actually is

`_inbox/upnote export.zip` (5.4 MB) is UpNote's **native backup**, NOT a Markdown export:

- Structure: `<userId>/data/*.upnx` (live snapshots) + `<userId>/revisions/**/*.upn` (history).
- Each `.upnx` is **gzip-compressed, newline-delimited JSON** (`version:2` header line, then one
  JSON object per line). The newest/largest `data/*.upnx` is the full current DB snapshot.
- Record types in a snapshot: `user`, `notebooks` (×9), `notes` (×344), `organizers`, `lists`,
  `filters`, `tags`, `workspaces`, `files`.
- **Note record** (`type:"notes"`) fields of interest:
  `id`, `title`, `html` (content as HTML), `text` (plaintext), `notebookId` (nullable),
  `createdAt`, `updatedAt`, `trashed`, `deleted`, `tagLinks`, `noteLinks`, `notebookLinks`,
  `pinned`, `bookmarked`, `fileIds`, `firstImage`.
- **Notebook record**: `id`, `title`, `parent` (nesting), `createdAt`, `deleted`.
- **Images**: inline in `html` as `<img width="100%" src="http://localhost:9425/images/<UUID>.jpg">`
  — UpNote's **local** image server. **88 distinct images referenced; ZERO image bytes in the
  export.** The pixels live only inside UpNote on the Mac → the laptop agent must fetch them.

---

## 2. Target model — how it lands in deltos

| UpNote | deltos | Notes |
|---|---|---|
| notebook | notebook (`notebook.ts` — flat, `name` ≤200) | deltos notebooks are **flat**; UpNote `parent` nesting flattens (see §6). |
| note.title | note title (**plain text**, no markdown) | `stripTitleMarkdown` runs server-side (`tools.ts:365`). |
| note.html (body) | note body = **spine blocks** via markdown | Convert HTML→markdown on the Mac; MCP `text` → `markdownToBody` → native blocks. |
| note.notebookId | note.notebookId (nullable = "All Notes") | null is normal — synthetic All-Notes view. |
| createdAt/updatedAt | *(not settable via MCP today)* | See open question Q3 — MCP stamps its own `now`. |
| `<img src=localhost>` | **attachment block** → R2 blob (`{accountId}/{hash}`) | The hard part; needs the new `attach_image` tool (§4.2). |
| trashed/deleted | skip (or `trash_note` after) | Import live notes only by default (§6). |
| tags, noteLinks | *(deferred)* | deltos has no tag model; note-links need a second pass (§6). |

deltos stores the **spine, not HTML** (ADR-0002) — so the HTML→blocks conversion is a one-time
import concern, not a persisted format.

---

## 3. The import bundle (what the Mac agent produces)

A directory the desktop agent can walk deterministically:

```
upnote-bundle/
  notebooks.json      # [{ upnoteId, name, parent }]  — parent kept for optional path-flattening
  notes.ndjson        # one JSON object per note (schema below)
  images/             # the fetched bytes, named by the UUID from the <img src>
    019A50F9-....jpg
    ...
```

**`notes.ndjson` record:**
```json
{
  "upnoteId": "019A50F8-...",
  "title": "plain text title",
  "notebookUpnoteId": "019B0135-..." ,        // or null → All Notes
  "bodyMarkdown": "converted body, with images as tokens (see below)",
  "images": [ { "uuid": "019A50F9-...", "file": "images/019A50F9-...jpg", "mime": "image/jpeg" } ],
  "createdAt": 1762295067087,                  // ms epoch, carried for Q3
  "updatedAt": 1783474679652,
  "trashed": false
}
```

**Image tokens in `bodyMarkdown`:** the Mac agent rewrites each inline `<img>` to a **placeholder
token** the desktop agent will replace with a real attachment block after upload, e.g.
`{{deltos-image:019A50F9-...}}` on its own line. (Do NOT emit markdown `![](…)` — `markdownToBody`
does not ingest images; the placeholder is resolved via `attach_image`, §4.2 / §5.)

**HTML→markdown conversion** (on the Mac, where a full HTML parser is available): map UpNote's
`<h1-3>`, `<ul>/<ol>/<li>`, `<blockquote>`, `<pre><code>`, `<hr>`, `<b>/<i>/<s>`, `<a href>`, and
task-list markup to the markdown `create_note` accepts (enumerated at `tools.ts:327-331`). Strip
UpNote-proprietary wrappers. Anything unmappable → plain paragraphs (lossy-but-safe).

---

## 4. Prerequisite worker work — two new MCP tools

Both are thin wrappers over existing, tested plumbing. Add to `packages/worker/src/mcp/tools.ts`,
gated by the same `can()` op/resource/account chokepoint + `mcpWrite` cap as the other write tools.

### 4.1 `create_notebook`
- **Args:** `{ name: string (1..200) }`.
- **Op/resource:** `create` / `{ kind: 'workspace' }` (needs a workspace-scoped write token).
- **Execute:** reuse the existing notebook insert mutator (the one `mutateNotebooks.*` /
  `NavContent` create path calls) → return `{ id, name }`.
- **Why:** import must recreate notebooks before filing notes; today only `list_notebooks` (read)
  exists (`tools.ts:275`).

### 4.2 `attach_image` (the important one)
- **Args:** `{ noteId, bytesBase64, name, mime }` (accept `bytesBase64` so the Mac agent can push the
  pixels it fetched; a `claimedHash?` is optional — `storeBlob` verifies it).
- **Op/resource:** `write` / `{ kind: 'note', id: noteId }`.
- **Execute:**
  1. `storeBlob(env, accountId, bytes, mime, { claimedHash })` (`blobStore.ts:126`) → server-computed
     SHA-256 hash + size, R2 key `{accountId}/{hash}`, charges the denial-of-wallet quota fail-closed.
  2. `bakeImageDerivatives(env, accountId, hash, bytes)` (`blobStore.ts:82`) → webp derivative
     (same as the client upload path, so search/OCR + fast render work).
  3. Build the attachment block `{ hash, name, mime, size }` (`attachmentBlock.ts:40`) and **append**
     it to the note body (CAS on the note's version, exactly like `append_block` `tools.ts:449`).
  4. Return `{ status: 'applied', hash }`.
- **Alternative considered:** let the Mac agent `POST /api/plugin/blob` directly over REST (the
  route already content-addresses + verifies, `blob.ts`), then a lighter MCP tool that only *inserts
  an attachment block for an existing hash*. Cleaner separation, but two round-trips and depends on
  the agent token's REST scope covering `/api/plugin/blob`. **Recommendation: the single
  `attach_image` tool above** — one call, one scope, all server-side.
- **Security:** identical posture to `blob.ts` — server computes the hash (never trusts the client's),
  account is server-derived, quota charged before the R2 put. No new attack surface.

*(Both tools should also be declared for the agent guide per the plugin-declares-agent-tooling
direction, so the desktop agent discovers them on `initialize`.)*

---

## 5. Desktop-agent runbook (the import algorithm)

Ordered so every reference resolves. Idempotency: keep a local `upnoteId → deltos id` map so a
re-run skips already-created notebooks/notes.

1. **`list_notebooks`** → read existing + the `routingGuide`.
2. **Notebooks:** for each `notebooks.json` entry not already mapped → **`create_notebook(name)`**;
   record `upnoteId → notebookId`. (Flatten `parent` per §6 / Q1.)
3. **Notes** (stream `notes.ndjson`, skip `trashed` unless Q2 says otherwise): for each note —
   a. **`create_note({ title, text: bodyMarkdown-with-placeholders-stripped, notebookId })`**
      → capture the new `noteId`. (Strip the `{{deltos-image:…}}` tokens from the text; images are
      added next as real blocks.)
   b. For each entry in `note.images`: read `images/<uuid>` bytes → **`attach_image({ noteId,
      bytesBase64, name, mime })`**. (Order = document order; append preserves it.)
   c. Record `upnoteId → noteId`.
4. **(Optional 2nd pass) note-links:** once all notes exist, rewrite `noteLinks` to deltos note
   refs (deferred — see §6).

Throughput: respect the `mcpWrite` daily cap (100/day, `GOTCHA-0014`); 344 notes + 88 images is
~430 writes → **the cap must be raised or waived for the import window**, or run it across days.
Flag this to Jim (open question Q4).

---

## 6. Edge cases & deferred scope

- **Nested notebooks:** deltos notebooks are flat. Default: flatten to the leaf name; if collisions
  or lost context, prefix with parent (`Parent / Child`). (Q1.)
- **Trashed/deleted notes:** import **live only** by default (skip `trashed:true`/`deleted:true`).
  deltos trash is a version-property flag, not a first-class import target.
- **Tags:** deltos has no tag model — **dropped** in v1 (could append a `#tag` line to the body if
  Jim wants them preserved as text).
- **Note-links / notebook-links:** UpNote internal links → deltos note refs need the full id map, so
  a **second pass** after all notes exist. Deferred unless Jim needs them now.
- **Revisions (`.upn`):** UpNote per-note history — **not imported** (deltos has its own history).
- **`firstImage` / cover:** cosmetic; ignore.

---

## 7. Open questions for Jim

1. **Notebook nesting** — flatten to leaf name (default), or `Parent / Child` prefixing?
2. **Trashed notes** — skip (default), or import into deltos trash?
3. **Timestamps** — MCP stamps its own `now`; do you care about preserving UpNote `createdAt`
   ordering? If yes, `create_note` needs an optional `createdAt` (small add) — otherwise all 344
   notes cluster at import time.
4. **Write cap** — 344 notes + 88 images ≈ 430 writes vs the 100/day `mcpWrite` cap. Raise/waive for
   the import, or spread across days? (Recommend a temporary waive on your own token.)
5. **Tags & note-links** — drop for v1 (default), or preserve (tags as text / links as a 2nd pass)?

---

## 8. Build checklist (deltos side, if we proceed)

- [ ] `create_notebook` MCP tool (+ guide declaration) — reuse notebook insert mutator.
- [ ] `attach_image` MCP tool (+ guide declaration) — reuse `storeBlob` + `bakeImageDerivatives` +
      attachment-block append (CAS like `append_block`).
- [ ] (Q3) optional `createdAt` on `create_note`.
- [ ] (Q4) temporary `mcpWrite` cap waive for the import token.
- [ ] Unit tests: both tools (happy + hash-mismatch + quota + CAS-conflict), mirroring the existing
      write-tool test bar.
- [ ] The Mac-agent bundle-prep prompt (separate doc Jim hands to the desktop app).
