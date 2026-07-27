# Spec — Real ChatGPT MCP connector support (`search` + `fetch`)

Status: **DRAFT for build** · Owner: (this session, orchestrating) · Target: live @ `deltos.blackgate.studio/api/mcp`

## 0. Goal & scope

Make the deltos MCP server connectable to **ChatGPT as a connector** — both:
- **Developer Mode** (full MCP, arbitrary tools) — already works today; no code needed.
- **Standard connector / Deep Research** — requires two specifically-named, read-only tools
  `search` and `fetch` with an exact result contract. **This is the gap this spec closes.**

Non-goals: rewriting the transport, changing OAuth, touching the client bundle, or altering any
existing tool. This is **purely additive**: two new tool defs on the existing MCP registry.

## 1. What already qualifies (do NOT rebuild)

Verified in code — these are done and must be left intact:

| Requirement | Status | Evidence |
|---|---|---|
| Streamable HTTP transport (stateless POST → JSON) | ✅ | `routes/mcp.ts`; GET→405 is spec-allowed |
| Protocol versions `2025-06-18 / 2025-03-26 / 2024-11-05` | ✅ | `mcp/protocol.ts:76` |
| OAuth 2.0 + Dynamic Client Registration + `.well-known` discovery | ✅ | `routes/oauth.ts`; `WWW-Authenticate: Bearer resource_metadata=…` on 401 (`routes/mcp.ts`) |
| **Dual-format tool results** (`structuredContent` + JSON-encoded `content[].text`) | ✅ | `toolOk()` `protocol.ts:104` already emits BOTH — this is exactly what ChatGPT requires |
| Per-call `can()` scope gate; read-only tokens can't reach writes | ✅ | `handleToolsCall` in `routes/mcp.ts` |
| Real citation-worthy note URL | ✅ | BrowserRouter → `https://deltos.blackgate.studio/note/<id>` |
| spine → markdown serializer (for `fetch.text`) | ✅ | `spineToMarkdown(blocks, {title})` in `@deltos/shared` (`spine/markdownOut.ts`) |

## 2. The exact ChatGPT contract (authoritative — from OpenAI docs)

**`search` tool**
- Input: `{ "query": string }` (single required string param; no others for the connector path).
- Output object: `{ "results": [ { "id": string, "title": string, "url": string } ] }`
  - `url` MUST be a non-empty string or ChatGPT emits **no citation** for that result.
- Returned via `toolOk(resultObj)` → automatically both `structuredContent` and JSON text. ✔

**`fetch` tool**
- Input: `{ "id": string }` (single required string — the id from a `search` result).
- Output object: `{ "id": string, "title": string, "text": string, "url": string, "metadata": object }`
  - `text` = the FULL note content as a string (markdown).
  - `metadata` = free-form object; we populate `{ notebookId, updatedAt }` (+ trashed flag if set).
- Returned via `toolOk(resultObj)`. ✔

Both tools are **read-only** and must be callable by **every token this app mints** (they all carry
read scope). No new scope/op is introduced.

## 3. Build plan (additive, in `packages/worker/src/mcp/tools.ts`)

### 3.1 `search` tool def
- `name: 'search'`
- `description`: concise, ChatGPT-facing — "Search the user's deltos notes by free text; returns a
  list of matching notes as `{id, title, url}`. Use `fetch` with an id to read full content."
- `inputSchema`: `{ type:'object', properties:{ query:{ type:'string' } }, required:['query'], additionalProperties:false }`
- `argsSchema`: `z.object({ query: z.string().min(1) }).strict()`
- `op: 'search'`, `resource: () => ({ kind: 'workspace' })` (search the whole account, unscoped —
  mirrors `search_notes` with no `notebookId`).
- `execute`: `searchNotes(db, undefined, accountId, args.query)` → map each row to
  `{ id: row.id, title: row.title, url: noteUrl(row.id) }` → `toolOk({ results })`.

### 3.2 `fetch` tool def
- `name: 'fetch'`
- `description`: "Read one deltos note in full by its id (from `search`). Returns `{id, title, text,
  url, metadata}` where `text` is the note body as markdown."
- `inputSchema`: `{ type:'object', properties:{ id:{ type:'string' } }, required:['id'], additionalProperties:false }`
- `argsSchema`: `z.object({ id: NoteIdSchema }).strict()`
- `op` + `resource`: mirror `get_note` EXACTLY (same op, `resource: (a) => ({ kind:'note', id:a.id })`)
  so ownership/notebook-grant coverage is inherited by construction.
- `execute`: `getNoteForAccount(db, accountId, args.id)`; if null → `toolError('note not found')`.
  Else build:
  - `text = spineToMarkdown(note.body, { title: note.title })`
  - `metadata = { notebookId: note.notebookId ?? null, updatedAt: note.updatedAt }` (+ `trashed:true` if `isTrashed`)
  - `toolOk({ id: note.id, title: note.title, text, url: noteUrl(note.id), metadata })`

### 3.3 `noteUrl` helper
- Single source of truth for the citation URL. `noteUrl(id) => \`${APP_ORIGIN}/note/${id}\``.
- `APP_ORIGIN` must be **derived from config, not hardcoded**. Prefer an existing env/origin value.
  If none is threaded to the MCP tool context, add `appOrigin: string` to `McpToolContext` and set it
  in the route from the request origin (the same origin used to build the `WWW-Authenticate`
  `resource_metadata` URL in `routes/mcp.ts`). **Do not hardcode `blackgate.studio` in tool code.**

### 3.4 (Recommended) declare `outputSchema`
OpenAI recommends tools declare an output schema so the client validates result shape. Current
`tools/list` only emits `inputSchema`. Add an OPTIONAL `outputSchema` field to the tool def type and
thread it through `toolListPayload` (emit only when present, so existing tools are unchanged). Give
`search` and `fetch` the output schemas from §2. This is a nice-to-have, not a blocker — if it risks
touching the shared registry type in a way that ripples, ship without it and note the follow-up.

### 3.5 Agent guide (`instructions`) touch-up
The `deltos` instructions block (`tools.ts:865`+) documents the `search_notes → get_note` flow. Add
one line noting `search`/`fetch` are ChatGPT-connector aliases of the same read path (so a Developer-
Mode agent isn't confused by two search tools). Keep it to a sentence — `instructions` is paid per
session.

## 4. Correctness invariants (must hold)

1. **No isolation regression** — `search`/`fetch` route through `searchNotes` / `getNoteForAccount`,
   which are `WHERE accountId = ?` by construction. Never hand-write a query. A token must NEVER see
   another account's note via these tools.
2. **`fetch` honors the same ownership gate as `get_note`** — a notebook-scoped token must NOT fetch a
   note outside its granted notebooks. Achieved by mirroring `get_note`'s `op`/`resource` so the
   `can()` chokepoint decides identically. **Add a test proving fetch is denied cross-scope.**
3. **`url` is always non-empty** for real notes (citation requirement).
4. **`text` never leaks internal encodings** — it's `spineToMarkdown` output (human markdown), not raw
   spine JSON.
5. **Read-only** — neither tool mutates. No write cap, no approval path.
6. **`search` returns `{results:[…]}`**, `fetch` returns the flat document object — shapes exactly per
   §2 (ChatGPT parses these; a wrong key name = silent connector failure).

## 5. Tests (co-located, mirror existing MCP tool tests)

- `search` returns `{results}` with `{id,title,url}` per hit; url matches `.../note/<id>`; empty query
  rejected by `argsSchema`.
- `fetch` returns all six-ish fields; `text` is markdown; unknown id → `toolError`.
- **Cross-account**: account B's token `fetch`ing account A's note id → denied (not found / scope).
- **Cross-notebook**: notebook-scoped token `fetch`ing an out-of-scope note → denied.
- `tools/list` now includes `search` and `fetch` for a read-only token.
- Existing tool tests still green (additive change proof).

## 6. Deploy & live verification

1. `pnpm --filter @deltos/client build` (no client change, but keep the build gate honest) + worker
   typecheck/tests green.
2. Deploy: `cd packages/worker && source ~/.config/cloudflare/bashenv.sh && script -qec "npx wrangler deploy" /dev/null`.
3. Verify served worker version; MCP is server-only so no SW/CDN asset concern.
4. **Live connector test** (the real gate): in ChatGPT → Settings → Connectors → add
   `https://deltos.blackgate.studio/api/mcp`, run the OAuth consent, confirm:
   - OAuth DCR + consent completes (this also validates the DCR path against ChatGPT's client, which
     has only been proven against Claude so far — watch for redirect/registration differences).
   - `search` + `fetch` appear and a query returns cited results that open the right note.

## 7. Risks / watch-items

- **DCR parity**: OAuth DCR is proven vs Claude's connector; ChatGPT may exercise different
  registration/redirect assumptions (and now nudges toward CIMD — Client ID Metadata Documents). If
  connect fails at auth, capture the actual failing request/response before theorizing (per
  [[prod-diagnosis-confirm-actual-failure]]).
- **SSE expectation**: older ChatGPT required an SSE stream; current builds accept Streamable HTTP
  (our stateless POST). If ChatGPT insists on GET-SSE, that's a transport follow-up, not part of this
  shim — flag it, don't pre-build.
- **Note URL auth**: `/note/<id>` requires the user's own login to open. Fine for Jim's own account;
  citations are just links.
