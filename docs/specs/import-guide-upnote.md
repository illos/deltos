# Import map: UpNote → deltos (agent-facing guide)

> This is the **content** served by the `get_import_guide({ source: "upnote" })` MCP tool — the
> "import map" an agent reads when the user asks to import their UpNote notes. It is written in the
> second person, addressed to the importing agent.
>
> **This doc is the AUTHORED source of truth for the guide prose; the RUNTIME copy shipped to the
> agent lives in `packages/worker/src/mcp/importGuides.ts` (the `upnote` entry).** Keep the two in
> sync when you edit either — the worker has no `.md` loader, so the guide is a TS template string
> there, not a read of this file.
>
> Source of truth for the deep detail: `docs/specs/upnote-import-spec.md`. This guide is the
> distilled, agent-facing recipe.

---

## When to use this
The user wants to move their **UpNote** notes into deltos. Follow this map exactly — it encodes
non-obvious environment facts that will otherwise waste a lot of effort.

## Prerequisites & environment (read first — this is where imports fail)
1. **You must run from the machine that has UpNote installed and its data present** (the user's Mac).
   The images are the reason: UpNote stores note images on the local disk and serves them ONLY from
   its own local server at `http://localhost:9425/images/<UUID>.jpg`. Those URLs work **only while
   UpNote is running on that machine** — they are not public, and the image **bytes are NOT included
   in UpNote's export**. If you are not on that machine (or UpNote is closed), you cannot get the
   images. Confirm both before starting.
2. **Get the export:** UpNote → Settings → export **all notes**. This produces a `.zip` whose entries
   are `<userId>/data/*.upnx` and `<userId>/revisions/**/*.upn`. You want the `data/` snapshots.
3. **You will need write access to deltos** — a workspace-scoped write token (the media/notebook
   write tools require it). If `list_notebooks` works but writes are denied, ask the user to grant a
   write-scoped token.

## Source format (how to read the export)
- Each `data/*.upnx` is **gzip-compressed, newline-delimited JSON**: a `version:N` header line, then
  one JSON object per line. Decompress with gzip, split on newlines, `JSON.parse` each non-header
  line. The **largest / newest** `data/*.upnx` is the full current DB snapshot — use that one.
- Record `type`s you care about: `notebooks` and `notes`.
- **Note** record fields: `id`, `title`, `html` (content, as HTML), `text` (plaintext), `notebookId`
  (nullable → uncategorized), `createdAt`, `updatedAt` (both ms epoch), `trashed`, `deleted`.
- **Notebook** record fields: `id`, `title`, `parent` (nesting), `deleted`.
- **Images** appear inline in `html` as `<img ... src="http://localhost:9425/images/<UUID>.jpg">`.
  Fetch each from that local URL to get the bytes.

## The deltos recipe (tool sequence)
Keep a local map of `upnoteId → deltosId` so a re-run is idempotent (skip already-created items).

1. **`list_notebooks`** — see what already exists and read the returned `routingGuide` (the user's
   filing rules; honor them).
2. **Create notebooks.** For each UpNote notebook (skip `deleted:true`) not already mapped, call
   **`create_notebook({ name })`**. deltos notebooks are **flat** — if UpNote nests via `parent`,
   flatten to the leaf name, or prefix `Parent / Child` if the bare name would be ambiguous. Record
   the returned id.
3. **Create each note** (stream the notes; skip `trashed:true` / `deleted:true` unless the user asks
   to include trash):
   a. Convert the note's `html` body to **markdown** (deltos note bodies accept markdown: `#`
      headings, `-`/`1.` lists, `- [ ]` tasks, `>` quotes, ``` code ```, `---`, `**bold**`, etc.).
      Map UpNote's `<h1-3>`, `<ul>/<ol>/<li>`, `<blockquote>`, `<pre><code>`, `<hr>`, `<b>/<i>/<s>`,
      `<a>` accordingly. Leave `<img>` OUT of the markdown — images are added as real blocks next.
   b. Call **`create_note({ title, text: markdownBody, notebookId, createdAt, updatedAt })`** — pass
      the note's original `createdAt` AND `updatedAt` (ms epoch) so both the note's date and its
      recency-sort survive the import (omit them and every imported note clumps at "now"). Capture
      the new note id.
   c. For each `<img>` in the note, in document order: fetch the bytes from its
      `localhost:9425/images/<UUID>` URL, base64-encode them (standard base64, ≤~6 MB decoded), then
      call **`embed_file({ note_id, filename, mime, content_base64 })`** to upload it to deltos R2 as
      a first-class artifact and embed it in the note. (`embed_file` appends in document order.)
4. **File-only notes / attachments** (a note that is essentially a single file): you may instead use
   **`create_file_note({ filename, mime, content_base64, notebookId, created_at, updated_at })`** to
   create a first-class file note (title = filename, body = the file/image), preserving its original
   dates via `created_at`/`updated_at` (ms epoch).

## Caveats
- **Write cap:** deltos rate-limits agent writes (~100/day by default). A full UpNote library (e.g.
  ~344 notes + ~88 images ≈ ~430 writes) will exceed it — ask the user to raise/waive the cap on the
  import token for the import window, or run it across days.
- **Tags & internal note-links:** deltos has no tag model; UpNote tags are dropped (or append them as
  `#tag` text if the user wants them kept). Internal note→note links need a second pass after all
  notes exist (all ids known) — do that only if the user asks.
- **Revisions (`.upn`):** UpNote per-note history is NOT imported; deltos keeps its own history going
  forward.
- **Idempotency & failure:** on any tool error (conflict, quota, not-found), stop and report which
  note/image failed and the running `upnoteId → deltosId` map, so the user can resume without dupes.
