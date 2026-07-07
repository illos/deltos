# deltos — feature map

> **Purpose.** One grounded inventory of everything the app does, grouped into starter
> buckets, so we can categorize and detail from a shared picture. Generated from a
> code sweep (2026-07-05) — treat it as a living doc: the buckets are a *starting
> taxonomy*, not a final one. Re-slice freely.

**Status legend:** `[live]` shipped to deltos.blackgate.studio · `[built]` in the codebase,
maybe not fully surfaced · `[wip]` in progress · `[designed]` speced, no code yet ·
`[future]` planned/architectural seam only · `[shelved]` explored & parked.

Each entry is `**Feature** — one line. [status]` with sub-bullets for distinct
sub-capabilities and a `↳ code:` pointer to the primary file/dir (client paths are under
`packages/client/src/`, worker under `packages/worker/src/`).

---

## 1. Editor & authoring
The writing surface — a ProseMirror editor over deltos's own document model.

- **ProseMirror editor core** — the note editor: view mounting, transaction dispatch, unified input pipeline, native + Deck typing. `[live]` ↳ `editor/ProseMirrorEditor.tsx`, `editor/schema.ts`
- **Spine document model** — deltos stores a block-based "spine" (content-opaque segments), NOT PM JSON, so editor node-model changes cost zero data migration (update the serializer pair only). `[live]` ↳ `editor/serializer.ts` (`spineToPmDoc`/`pmDocToSpine`)
- **Note-view resolution** — notes can render through alternative view components (not just the block editor) based on type/properties; plugins can register views. `[live]` ↳ `editor/views.ts`
  - Block editor (text notes) · File-note view (files/PDF/image) · seam for future kanban/board/calendar collection views
- **Unified input-transform pipeline** — one registry drives ALL input-triggered transforms (markdown, formulas, autolink), consumed identically by native typing and the Deck. Registration order = precedence. `[live]` ↳ `editor/editorTransforms.ts`, `editor/inputPipeline/`
  - 21-case invariant corpus (never shrink) · pre-insert / post-insert / bulk-paste phases
- **Markdown shortcuts** — `# `, `> `, ``` ``` ```, `- `/`1. `, `[ ]`, `---`, and inline `**bold**` / `*italic*` / `~~strike~~` / `==highlight==` / `` `code` `` auto-format on trigger. `[live]` ↳ `editor/inputRules.ts`
- **Backspace-reverts-autoformat** — one Backspace right after a transform restores the literal trigger text; second deletes normally. `[live]` ↳ `editor/inputPipeline/undoTransform.ts`
- **Links & autolink** — manual links + auto-linkification of trailing URLs on space/enter (curated TLD allowlist), with backspace-unwrap. `[live]` ↳ `editor/autolink.ts`, `editor/commands.ts`
- **Undo / redo** — prosemirror-history with ~500ms typing-coalesce grouping. `[live]`
- **Slash palette** — `/` at block-start opens a command palette (formula, link card, formatting tools, file/image) fed by plugin manifests. `[live]` ↳ `editor/slashPalette/`
- **Version history + capture** — per-device (unsynced) snapshots on conflict / session-idle / foreign-overwrite; timeline + character-level diff + restore. `[live]` ↳ `components/HistoryPanel.tsx`, `db/conflict.ts`
- **Info panel (ⓘ)** — full-screen per-note metadata (created/edited/notebook/word+char count/sync status; file notes add filename+rename/type/size/download). `[live]` ↳ `components/InfoPanel.tsx`
- **Full-window note + pop-out** — immersive `/note/:id/full` view and a `window.open()` pop-out. `[live]` ↳ `components/NoteMetaBar.tsx`
- **Lightbox** — tap an inline image → fit-to-screen overlay (reuses the loaded blob, no refetch). `[live]` ↳ `components/Lightbox.tsx`
- **Inline image drag-resize** — grip handle sets width, one commit on release, persists in the attachment's pluginContent (rides sync, no schema change). `[live]` ↳ `plugins/attachment/imageResize.ts`
- **Voice dictation** — Workers-AI Whisper transcription integrated with the Deck. `[live]` ↳ `editor/voiceTranscriber.ts`, `deck/voice/`
- **Spell check** — off-thread engine, live squiggles, tap-to-correct, account-synced custom dictionary. `[live]` ↳ `editor/spellcheckPlugin.ts`
- **Clipboard round-trip** — markdown-flavored copy; structure-preserving in-app paste; markdown paste → blocks/marks. `[live]` ↳ `editor/clipboard.ts`, `editor/markdownPaste.ts`

## 2. Deck & mobile input / navigation
deltos's custom on-screen keypad (Jim's daily driver) and the mobile nav model.

- **Custom keypad** — QWERTY / 123 / symbol layers with pixel-native iOS geometry, hosted in place of the OS keyboard (`inputmode=none`). `[live]` ↳ `deck/loadouts/Keypad.tsx`
  - 3-state shift (lower/one-shot/caps-lock) · spacebar-hold trackpad caret move · auto-capitalize · accelerating backspace · key-pop balloons · double-space → ". "
- **Keypad loadout + base region** — collapsible keypad over a fixed 47px control band (toggle, group selector, undo/redo, formatting toolbar); top-slot overlay for spell/formatting/voice. `[live]` ↳ `deck/loadouts/KeypadLoadout.tsx`
- **Show/hide mechanics** — auto-show on caret tap, auto-hide on fast scroll, long-press toggle to lock; iOS selection-clearance scrolling. `[live]` ↳ `useKeypadSwipe.ts`, `lib/deckClearance.ts`
- **Native-keyboard fallback mode** — when the custom keyboard is off, the Deck flips to a top toolbar (`body.deck-top`) above the OS keyboard. `[live]` (per [[native-keyboard-is-fallback-only]]) ↳ `editor/MobileEditorBar.tsx`, `components/DeckHost.tsx`
- **Drag-up NavSheet** — the app's primary mobile navigation: a bottom sheet dragged up from the Deck / a universal float handle. `[live]` ↳ `components/NavSheet.tsx`
- **"…" context-menu sheet** — bottom-sheet surface for note/notebook options; currently an empty shell (ROAD-0013). `[built]` (shell only) ↳ `components/ContextMenuSheet.tsx`
- **Swipe actions (note list)** — iOS-Mail right-swipe Copy + Delete (fling-to-delete); left-swipe Move-to-notebook. `[live]` (right) / `[wip]` (left-move) ↳ `components/SwipeRow.tsx`
- **Mobile editor bar** — contextual formatting toolbar (group toggles + undo/redo), in the Deck's top slot or a sticky sub-bar. `[live]` ↳ `editor/MobileEditorBar.tsx`
- **Deck host & context publishing** — app-agnostic Deck mount; editor publishes its loadout live; context (text/node/toolbar/search) picks the visible loadout; persists across routes. `[live]` ↳ `components/DeckHost.tsx`, `editor/deckAdapter.ts`
- **Touch/PWA gating** — custom keyboard only in installed PWA + touch-primary; yields to hardware keyboards; iOS scroll-lock. `[live]` ↳ `useTouchPrimary.ts`, `useInstalledPwa.ts`, `lib/bodyScrollLock.ts`
- **Future:** search-keypad filter row · voice waveform top-slot · context-menu residents (rename/organize/display/share) · iOS keyboard accessory bar · pin swipe seam. `[future]`

## 3. Plugins & extensibility
The framework that lets block types, formula types, tools, and views register additively.

- **Plugin manifest spine** — two-tier declarative registration: tiny tier-1 metadata in the editor chunk, lazy tier-2 runtime via `load()`; aggregates into formula/NodeView/tool/PM-plugin registries. `[live]` ↳ `plugins/runtime/manifest.ts`, `builtins.ts`
- **Registry & lazy loader** — eager contributions collected at editor-init; heavy plugins dynamic-imported on demand and cached. `[live]` ↳ `plugins/runtime/registry.ts`
- **Content-presence activation** — a plugin loads when a note's body holds its block type; unknown/not-yet-loaded blocks show a lossless placeholder, upgraded in place once the runtime loads (scan on INSERT *and* on OPEN — GOTCHA-0022). `[live]` ↳ `editor/nodeviews/PluginIsland.ts`
- **Capability & security model** — host capabilities (blob/records/net/compute/…) are server-enforced; client is the seam, never the gate; presentation caps (offline/online-only/collaborative) drive degraded render. `[live]` ↳ `plugins/runtime/renderContext.ts`, `routes/blob.ts`
- **Render-only path** — PM-free renderers for search peek / list preview / history diff / share; unknown types fall back to raw placeholder. `[live]` ↳ `plugins/runtime/renderOnly.tsx`
- **Built-in plugins:** formula (§5) · link-card/embeds · core-tools (30+ formatting descriptors) · attachment (§4). `[live]` ↳ `plugins/embeds/`, `editor/editorTools.ts`
- **Link-card / embeds** — bare-URL paste → server unfurl (`/api/unfurl`) → title/description/favicon card. `[live]` ↳ `plugins/embeds/`
- **Future:** loadable/third-party plugins (framework additive) · interactive/stateful formula types (e.g. dice with re-roll) · loadout-scoped registries (TTRPG/game-design sets) · plugins declaring their own agent/MCP tooling. `[future]`

## 4. Attachments & files
Files as first-class content and as whole-note artifacts.

- **Attachment block (drop/paste)** — files/images via drag-drop or clipboard → loading block → async upload → filled block; one build path backs file notes, inline file chips, and inline images. `[live]` ↳ `plugins/attachment/attachmentDrop.ts`
- **Blob client** — content-addressed 3-tier fetch (memory → per-account IndexedDB → network), Bearer-authed with 401/403/503 re-mint-and-retry; account-isolated, LRU-bounded. `[live]` ↳ `plugins/attachment/blobClient.ts`
- **Direct-to-R2 upload** — large files bypass the Worker via a checksum-scoped presigned PUT (≤2 GB); server verifies the client hash; progress tracked, no orphan note on abort. `[live]` ↳ `routes/blob.ts`, `lib/uploadStore.ts`
- **Upload progress cards** — transient per-upload pills (filename + %, cancel), entry-bundle-safe, persist across navigation. `[live]` ↳ `components/UploadProgressHost.tsx`
- **File notes (FileNoteView)** — a note whose body is one attachment block; image preview / PDF reader / download chip; rename + delete; lazy chunk. `[live]` ↳ `views/FileNoteView.tsx`
- **PDF reader** — hardened lazy pdf.js (no scripting/eval/annotations); single worker + priority render queue (main > thumbnail > search); DPR-aware; `?page=N` deep-link. `[live]` ↳ `views/pdf/`
- **File-content search** — PDF pages text-extracted + images OCR'd (Workers-AI Gemma) into a `sys:extract` property → fed to search with snippet + "p. N" badge + deep-link. `[live]` (ROAD-0014) ↳ `worker/src/extraction.ts`, `views/pdf/pdfSearch.ts`
- **Images pipeline** — Workers Images dual-bake (256² thumb + 2048px view WebP) at upload; derivative self-heal on 404. `[live]` ↳ `routes/blob.ts`
- **Future / shelved:** multipart upload > 2 GB `[future]` · in-app doc scanner (jscanify) `[shelved]` — native "Scan Documents" via file picker stays.

## 5. Formulas & compute engine
Inline editable "formula" pills that compute — and the reactive engine being built under them.

- **Formula framework** — inline nodes that detect + evaluate + render; bracket `[...]` path and per-type auto-triggers; output is type-owned (text/visual/interactive); spec stays editable, result never persisted. `[live]` ↳ `plugins/formula/`
  - **Math** — safe arithmetic engine (no `eval`), `[2+2]` or `=`-trigger → ` = N`. `[live]` ↳ `plugins/math/` (`mathEngine.ts`)
  - **Imperial-units adder** — carpenter's measurement list, canonical unit = inches, sums → feet+inches rounded up to 1/32; straight & curly marks, `label:` tag, mixed fractions. `[live]` ↳ `plugins/imperial/`
  - **Hex-color** — `#RGB(A)` → live color swatch. `[live]` ↳ `plugins/hexcolor/`
- **Shared numeric substrate** — refactor extracting math + imperial onto one "reduce source → scalar number" base (`toNumber`/`format`); behavior-preserving. `[wip]` ↳ (Fable head-dev task; design in `docs/specs/formula-engine.md`)
- **Reactive compute engine** — host-agnostic dependency graph + resolver + incremental recompute + cycle detection; the shared core for note formulas now and a future spreadsheet/DB. `[wip/designed]`
  - Named formulas (`[Y: 2+2]` → variable) · cross-formula references (`[12 x [Y] / 2 =]`) · totalizer (`[J:total]` sums all label-J formulas) · bare `[Label]` = sum-of-group
  - Values flow as raw scalars (no dimensional analysis); consuming type owns display; values never persisted (recomputed on open); lazy + presence-gated for load-feel
- **Future:** spreadsheet / Notion-style database plugin reusing this engine as its compute core. `[future]`

## 6. Sync & data layer
Local-first storage and eventual-consistency sync.

- **Local store (Dexie/IndexedDB)** — reactive liveQuery over notes/notebooks/versions; account-scoped; queue entries for push; blob cache; device-local state (never synced). `[live]` ↳ `db/dexieLocalStore.ts`, `db/schema.ts`
- **Sync engine** — push-queue drain with per-note CAS baseVersion (latest-wins dedupe); pull-while-visible ~2s; push ~2s idle-settle / 5s max; single-flight; 401/403/503 re-mint. `[live]` ↳ `lib/syncEngine.ts`, `routes/sync.ts`
- **Conflict-as-version** — a CAS-conflict keeps the divergent local edit as a version of the same note (non-destructive); badge + toast + ConflictView resolve. `[live]` ↳ `db/conflict.ts`, `components/ConflictView.tsx`
- **Account-scoped boundary** — sync scoped to the bearer's server-derived accountId (not device notebookId); per-account cursor; store wiped on account-switch/logout. `[live]` ↳ `db/accountScope.ts`
- **Offline-first** — shell renders before auth/sync; edits queue locally; never kicked to login outside first setup; pending-edit pull guard avoids phantom conflicts. `[live]` (ground rule [[offline-never-gate-on-network]])
- **Sync status indicator** — idle/pending/syncing/offline/error blip with tap-to-flush-reload. `[live]` ↳ `components/SyncIndicator.tsx`
- **Diagnostic snapshot** — ZIP of IndexedDB (incl. sync queue) + manifest + redacted localStorage; credentials omitted; lazy module. `[live]` ↳ `lib/diagnosticSnapshot.ts`

## 7. Notebooks, search & organization
How notes are grouped, found, and triaged.

- **Notebooks** — account-scoped synced entities: create/rename/delete (cascade to Trash), version + syncSeq; per-device current-notebook pointer. `[live]` ↳ `lib/notebookStore.ts`, `db/notebooks.ts`
- **All Notes (synthetic default)** — nullable `notebookId`; a null note = uncategorized, surfaced in the "All Notes" aggregate; no stored default row (duplicate-default impossible, migration 0010). `[live]`
- **Client fuzzy search** — offline in-app bigram-Dice full-text; title 3× weight; exact > prefix > fuzzy; indexes body + file extracts (page badge + deep-link). `[live]` ↳ `lib/search.ts`
- **SearchRoute UI** — full-screen local search, 200ms debounce, current-notebook flat + other-notebooks collapsible; peek without moving the pointer. `[live]` ↳ `routes/SearchRoute.tsx`
  - Desktop: in-place in the list pane · Mobile: pill → search mode, keys-only or native keypad
- **Trash (trash-as-version)** — soft-delete via `sys:trashedAt` flag (note stays live, recoverable); Trash view + Restore; notebook-delete cascades here; fail-safe predicate. `[live]` ↳ `routes/TrashRoute.tsx`
- **Note properties bag** — arbitrary user key-values + reserved `sys:*` namespace (trashedAt, extract, …) stripped on sync. `[live]` ↳ `shared/spine/reservedKeys.ts`
- **Collection views** — registry for alternative notebook views (list now; kanban/board/calendar v2+); per-notebook `defaultCollectionView`. `[built]` (list live; others future) ↳ `lib/collectionViews.ts`
- **Server search** — separate D1 FTS5 title+body engine for agent/MCP/REST consumers (kept intentionally distinct from client fuzzy). `[live]` ↳ `worker/src/db/mutate.ts` (`searchNotes`)

## 8. Auth, identity & security
Username+password identity, sessions, and the trust surfaces around them.

- **Username + password login** — Argon2id (PAID-tier CPU), uniform errors (no account oracle), gate-before-hash backoff. `[live]` ↳ `routes/passwordAuth.ts`, `passwordCrypto.ts`
- **Registration** — atomic unique username claim; forced recovery-phrase regeneration screen. `[live]`
- **Account model (D6)** — stable random `accountId` separate from the credential; one username per account; `accountId` = principal for authz + data scope. `[live]` ↳ `db/authStore.ts`
- **Refresh sessions** — httpOnly+Secure+SameSite=Strict rotating refresh cookie (60d), rotation-on-use + reuse-detection (revoke family); short-TTL in-memory access token. `[live]` ↳ `authPolicy.ts`
- **Token revocation / revoke-all** — per-session revoke, sign-out-everywhere-else, revoke-all on credential change. `[live]` ↳ `routes/sessions.ts`
- **TOTP 2FA (optional)** — RFC-6238, confirm-before-activate, AES-256-GCM at rest, replay guard, prompted only on new-device login + reset. `[live]` ↳ `totp.ts`
- **Recovery phrase → reset** — accountId-bound Argon2id verifier; reset sets new password + clears 2FA + revoke-all; stricter backoff. `[live]`
- **Active-sessions UI** — list families with device labels, revoke one, sign out others. `[live]` ↳ `components/SessionsSection.tsx`
- **Account-activity audit log** — append-only Analytics Engine (forensic truth) + D1 projection surfaced as a user-facing trust feed (login/token/session/MCP/REST events, IP/country/UA). `[live]` ↳ `audit.ts`, `components/ActivitySection.tsx`
- **Client account isolation** — per-account Dexie namespace; every query `WHERE accountId = ?`; routes stamp server-derived accountId. `[live]` ↳ `db/accountScope.ts`
- **Rate limiting & anti-abuse** — per-account login/reset/signup backoff, failure-triggered Turnstile, per-token MCP window, per-account daily quota, 200 req/10s per-principal API cap. `[live]` ↳ `authPolicy.ts`, `rateLimit.ts`
- **CSRF / cross-origin** — SameSite=Strict + Origin-header validation on cookie mutations, exact hostname match. `[live]`

## 9. MCP, API & connectors
The agent/integration surface.

- **MCP server** — stateless JSON-RPC 2.0, Bearer agent-token gated, live-token-at-door (401 on dead), scope-aware instructions, per-token rate + per-account quota, write cap fail-closed. `[live]` ↳ `routes/mcp.ts`, `mcp/protocol.ts`
- **MCP read tools** — `search_notes` (D1 FTS5), `get_note`, `list_notebooks` (least-privilege per-item filter). `[live]` ↳ `mcp/tools.ts`
- **MCP write tools** — `create_note`, `update_note` (CAS), `append_block`, `set_property` (no `sys:`), `trash_note` (soft); live-apply, recoverable via versions+trash+audit. `[live]`
- **MCP file tools** — `create_file_note`, `embed_file` (base64 ≤6 MB, server hash, BOLA-safe `{accountId}/{hash}`, dedupe + WebP bake). `[live]`
- **Agent tokens** — non-expiring, revocable, `dltos_agent_…` (only SHA-256 stored, shown once); step-up re-auth to mint; READ floor + per-scope WRITE opt-in; never `share`. `[live]` ↳ `routes/agentTokens.ts`, `shared/api/agentToken.ts`
- **OAuth 2.1 provider (one-click connect)** — server as its own Authorization Server: DCR, PKCE-S256-only, consent screen on a separate `/oauth/*` surface, exact-match redirect registration; token = agent grant, non-expiring, v1 read-only. `[live]` ↳ `routes/oauth.ts`, `shared/api/oauth.ts`
- **Connected apps UI** — lists OAuth grants + agent tokens together (client name, scope, per-resource), whole-token or per-resource revoke. `[live]` ↳ `routes/settings/ConnectionsTab.tsx`
- **REST API** — account routing-guide get/set, `pickables?q=` for the consent picker; owner-authed (agent tokens blocked); accountId server-derived. `[live]` ↳ `routes/account.ts`
- **Future:** the reusable connector/OAuth "pipe" (shared token vault + refresh + capability-scoping) for outbound integrations (calendar/note-import). `[designed]` ([[connector-oauth-plugin-pipe]])

## 10. Sharing, grants & collaboration
One grant primitive, delivered as agent scoping today and sharing/collab later (ROAD-0011).

- **Grants & `canWith` hierarchy** — one primitive `(principal, resource, scope[], constraints)`; resource = workspace | notebook | note; principals owner/device/guest/anonymous/agent/plugin verified server-side; one chokepoint evaluator with notebook→note coverage. `[live]` ↳ `worker/src/auth.ts`, `shared/api/grant.ts`
- **Grant sets** — one token → many resource rows (same tokenHash), any-of evaluation, per-resource revocation. `[live]` ↳ `db/authStore.ts`
- **Mint-path pickers** — resource picker on manual mint + OAuth consent (notebooks = list-select, notes = search-select); ownership-validated + clamped fail-closed. `[live]`
- **Resource-owner resolver** — live coverage follows a resource's current state (move a note out of a granted notebook → token loses it); hard-deleted → deny. `[live]` ↳ `db/resourceOwner.ts`
- **URL shares (read-only)** — server-rendered `GET /s/<token>` spine→HTML; anonymous grant; permanent-until-revoke; `spine→output`, not the React component. `[designed]` (P2)
- **1:1 read+write sharing** — guest principal + per-grant share feed; shared items inline with a "shared" pill; **revoke = fork** (recipient rows re-keyed, not purged) + per-principal version attribution. `[designed]` (P3)
- **Real-time collaboration** — Durable-Object-per-note; default checkout lease (one editor, others live-follow); opt-in session-scoped ephemeral CRDT that snapshots through the normal write path; per-plugin `collaboration: crdt|render-only`; offline still conflict-as-version. `[designed]` (P4)

## 11. App shell, UI & settings
The frame, chrome, and appearance.

- **App shell & routing** — master-detail: 3-region desktop (nav | resizable list | note) ↔ single-column mobile; routes `/new`, `/note/:id`(`/full`), `/trash`, `/search`, `/settings/:tab`, auth routes; boot-view gate (cold/unauth/authed). `[live]` ↳ `App.tsx`
- **Separate auth/settings surface** — OAuth/consent + account ceremonies live off the shell at `/oauth/*` (no-store, SW-denylisted), never wired into the app router/SW (DEC-0005). `[live]`
- **Settings (6-tab)** — Account, Appearance, Connections, Activity, Editor (dictionary + dev toggles), About/Diagnostics. `[live]` ↳ `routes/settings/`, `tabs.tsx`
- **Theme system** — 4 palettes (bone/graphite/manila/ember) × light/dark/system × 4 voices (serif/sans/mono/grotesk); device-local, applied to `<html>` data-attrs instantly, no-flash boot. `[live]` ↳ `theme/tokens.css`, `lib/themeStore.ts`
- **Icon set & fonts** — 40+ SVG icons; everyday fonts precached, specialty voices lazy; δ-wordmark subset. `[live]` ↳ `icons/index.tsx`
- **Toasts & indicators** — generic/action(undo)/conflict toasts, sync blip, session-status badge, upload cards. `[live]` ↳ `lib/toastEvents.ts`, `components/SyncIndicator.tsx`
- **Onboarding / auth ceremonies** — register (→ recovery phrase → optional TOTP), login (→ TOTP → forced-phrase belt), reset; `isAuthing` latch prevents shell unmount mid-ceremony. `[live]` ↳ `routes/RegisterRoute.tsx` etc.
- **List-pane features** — swipe row actions, desktop drag-to-move + file-drop overlay (lazy chunks), notebook pill in All-Notes, preview line + smart date, desktop keyboard-search entry. `[live]`

## 12. Backend, infra & deploy
The Cloudflare substrate.

- **Cloudflare Worker (Hono)** — REST API + auth chokepoint `guard()` (op + schema validation), 200 req/10s per-principal limit, `/api/health`. `[live]` ↳ `worker/src/index.ts`
- **API routes** — note CRUD (CAS, BOLA), `/api/sync` (pullSince/push, accountSyncSeq), `/api/transcribe` (Whisper), `/api/unfurl`, `/api/plugin/blob/*`, `/api/agent-tokens`, `/api/account`, `/api/audit`, `/api/mcp`, `/api/auth/*`, `/api/oauth/*`. `[live]` ↳ `worker/src/routes/`
- **D1 database** — SQLite, 20 numbered migrations; notes/notebooks, accounts/usernames, password+refresh sessions, grants, audit log, usage counter, custom dictionary, OAuth clients/codes, routing guide, grant sets, FTS5 (0018). `[live]` ↳ `worker/migrations/`
- **R2 blob storage** — private content-addressed bucket; presign + BOLA-scoped fetch with safe headers. `[live]` ↳ `routes/blob.ts`
- **Workers AI / Images** — Whisper (voice), Gemma (OCR); Images dual-bake + transcode. `[live]`
- **Service worker / PWA** — install-and-wait precache (no auto-swap, manual "Update now"), SPA navigation fallback with `/api/*`+`/oauth/*` denylist, CacheFirst fonts + pdf.js. `[live]` ↳ `client/src/sw.ts`
- **Scheduled cron** — daily 04:00 UTC retention prune (audit/usage) + extraction backfill sweep. `[live]`
- **Deploy pipeline** — `pnpm --filter @deltos/client build` → `wrangler deploy` (PTY); verify served `index-<hash>.js` + bust SW cache. `[live]` (live = dev; review on live) ↳ GOTCHA-0004
- **Env / secrets** — ENVIRONMENT, AUTH_AUDIENCE, R2 endpoint/keys, AUTH_PEPPER + TOTP_ENC_KEY (never re-put), cpu_ms 30000 (PAID). `[live]`
- **Observability** — Analytics Engine `deltos_audit` (forensic source of truth) + D1 projections. `[live]`

---

### Cross-cutting north-stars (context for categorizing)
- **Performance / load-feel** beats Apple Notes; no feature ships if it regresses load ([[performance-is-a-standing-value]]).
- **Plugins lazy past first paint**, runtime-registered; keep plumbing off the mobile first-load ([[plugins-lazy-past-first-paint]], [[backend-resident-plumbing-default]]).
- **Auth friction only for sync / new-device**; day-to-day never gated ([[auth-friction-philosophy]]).
- **Built for Jim** (personal app) — no hypothetical-stranger taxes ([[build-for-the-actual-user]]).
- **live = dev** — review real code on the live site, never a local preview ([[review-on-live-never-local-preview]]).
