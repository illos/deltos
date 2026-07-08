# Alert / Notification Banner System — design spec

> **Status: DESIGN (not built).** A GENERIC in-app alert surface, built once, that any producer can push a
> message into. First consumer specced end-to-end = **agent bulk-write approval** (an *actionable* alert).
> Second consumer designed-for-but-NOT-built = a **storage-warning** status alert (passive), to prove the
> model generalises with zero new surface work. Everything below is grounded in the current codebase with
> `path:line` citations; where I make a call I say so.
>
> **Migration number:** the highest applied migration is `0022_share-theme.sql`
> (`packages/worker/migrations/`), so the new table here is **`0023`**. Never rewrite an applied migration
> ([[migration-never-rewrite-applied]]).

---

## 1. Summary (5 bullets)

- **One alert surface, many producers.** A single client **alert store** (a plain module pub/sub, cloned from
  the working `toastEvents.ts` pattern, `packages/client/src/lib/toastEvents.ts:24-71`) aggregates alerts from
  BOTH server (rides sync-pull) and local producers, and drives ONE lightweight **`AlertBanner` host** mounted
  in both shells. Adding a new alert *type* is a **declaration** (an entry in an alert-kind registry mirroring
  `PLUGIN_AGENT_TOOLS`, `packages/shared/src/mcp/agentTools.ts:123`), never surgery on the surface.
- **The alert is a schema-first data shape.** A single extensible zod schema in `@deltos/shared`
  (`AlertSchema`) is the source of truth, crossing the sync HTTP boundary. Server alerts ride the EXISTING
  sync-pull as a new `alerts` array on `SyncPullResponse` — **additive and safe**: the pull response is not
  `.strict()` and the client only type-casts it (`packages/client/src/lib/syncEngine.ts:438`), so an older
  client silently ignores the field and no sync batch 400s.
- **Off-first-load by construction.** The banner host is a cheap module that renders `null` when no alert is
  active (exactly how `ToastHost` / `UploadProgressHost` behave today) — it adds no route, no poll, and no
  meaningful entry-bundle weight. The heavier *actionable* detail (Approve/Deny sheet) is `React.lazy`-split
  and only loaded when the user acts. No new always-on network poll: server alerts arrive on the ~2s
  visible-only pull that already runs (`packages/client/src/lib/syncEngine.ts:662,711`).
- **Consumer #1 — agent bulk-write approval.** A new **read-scope** MCP tool `request_write_approval({count,
  reason})` writes a durable, **token-scoped** pending-approval row (table `writeApproval`, migration 0023) →
  surfaces as an actionable alert (`[agent] wants to make ~430 writes: <reason>`) → the human taps Approve/Deny
  (account-scoped, BOLA-safe, audited REST) → an **effective-cap** function at the single write chokepoint
  (`packages/worker/src/routes/mcp.ts:237`) grants approved, **count- AND time-boxed** extra quota that
  auto-reverts to 100. The agent learns the outcome with a cheap `check_write_approval` read tool. The human
  seeing *scale + intent before granting* IS the injection defence: the agent can only **ask**.
- **Consumer #2 — storage warning.** A passive `storage` alert (produced server-side from the R2 sizer
  `accountUsage`, `packages/worker/src/blobStore.ts:61`) slots into the SAME schema + SAME carrier + SAME
  surface as a non-actionable, dismissible warning — zero new surface work. This is the proof the system is
  generic, not approval-shaped.

---

## 2. Inventory of existing notification UI + reuse-vs-new decision

There is already a small family of overlay/host surfaces. Inventory (all real paths, ignore
`.claude/worktrees/*` which are stale copies):

| Surface | File | Mechanism | Mounted | Lazy? |
|---|---|---|---|---|
| **Toast** | `lib/toastEvents.ts` + `components/ToastHost.tsx` (via `ConflictToastHostSlot.tsx`) | Plain module pub/sub: `_toasts[]` + `_listeners` Set + `_notify()` (`toastEvents.ts:24-30`); `showToast`/`showActionToast` (`:33,:48`); auto-dismiss 4.5s (`:11,:37`); `subscribeToasts` (`:67`). `ToastHost` `useState(getToasts)` + `subscribeToasts` (`ToastHost.tsx:32-35`), renders `null` when empty (`:37`). | Both shells: `App.tsx:748` (mobile), `App.tsx:580` (desktop), `:553` (full-note) | No — static import, but a cheap null-render module |
| **Upload progress** | `components/UploadProgressHost.tsx` + `lib/uploadStore.ts` | Zustand store; renders `null` when `uploads.length===0` (`UploadProgressHost.tsx:18`). Heavy hashing/XHR stays in the lazy `blobClient` chunk. | Both shells: `App.tsx:752,583,554` | No — static import, cheap null-render |
| **Context-menu sheet** | `components/ContextMenuSheet.tsx` | Bottom-sheet overlay: dimmed+blurred backdrop, `role="dialog" aria-modal`, `inert` when closed, backdrop-tap + Escape dismiss, grabber, thumb-zone close (`ContextMenuSheet.tsx:34-56`). z-index 350; backdrop `blur(8px)` gated to `--open`. | Mobile: `App.tsx:612` | No |
| **Nav sheet** | `components/NavSheet.tsx` | Drag-up spring sheet (`cubic-bezier(0.2,0.9,0.25,1)`), same backdrop-blur language, z-index 380. | Mobile: `App.tsx:744` | No (parked off-screen) |
| **Notebook-picker sheet** | `components/NotebookPickerSheet.tsx` | Bottom-sheet, z-index 400 (top overlay). | Conditional: `App.tsx:417` | No |
| **Lightbox** | `components/Lightbox.tsx` | Portals to `<body>`, z-index 1000, renders `null` until triggered. | Both shells: `App.tsx:755` | No |
| **Conflict badge** | `components/ConflictBadge*.tsx` | Inline per-row badge, not an overlay. | Per note row | — |

**Decision: the alert banner is a NEW host surface, but built entirely from reused parts.**

- **Reuse the toast pub/sub *pattern*, not the toast host itself.** A toast is transient (4.5s auto-dismiss,
  `toastEvents.ts:11`) and bottom-anchored; an alert is **durable** (persists until resolved/dismissed),
  possibly **actionable** (Approve/Deny), and **top-anchored** (Jim: "a banner at the top"). Overloading the
  toast host would fork its dismiss/animation model. So the alert store is a **sibling module** to
  `toastEvents.ts` — same `_items[]` + `_listeners` Set + `subscribe()` shape (zero new concepts), different
  lifecycle (no auto-TTL by default; server-driven presence).
- **Reuse the host-mount *posture*** from `ToastHost`/`UploadProgressHost`: a cheap module that renders `null`
  when the store is empty, statically imported into both shells. That is the codebase's proven "off-first-load"
  idiom — no route, no bundle-splitting needed for the shell itself.
- **Reuse the sheet overlay language** (`ContextMenuSheet`) for the *actionable* alert's expanded Approve/Deny
  detail: same backdrop-blur, `role="dialog"`, Escape/backdrop dismiss, thumb-zone buttons. This is
  `React.lazy`-split so a read-only day never loads it.

Net: **new store module + new banner host + new lazy detail sheet**, each a thin variant of an existing thing.

---

## 3. The generic alert model (shared schema) + how new types are declared

### 3.1 `AlertSchema` (source of truth — `packages/shared/src/api/alert.ts`, new)

A single extensible shape covering passive and actionable alerts. The `kind` string is the discriminator that
routes rendering; `action` is present only for actionable alerts.

```ts
// packages/shared/src/api/alert.ts   (NEW)
import { z } from 'zod';

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/** One actionable choice on an alert (e.g. Approve / Deny). `op` is the intent; `href` is the REST target
 *  the client POSTs to (account-scoped server-side). Passive alerts carry NO actions. */
export const AlertActionSchema = z.object({
  id: z.string().min(1),            // 'approve' | 'deny' | ...
  label: z.string().min(1),         // 'Approve'
  style: z.enum(['primary', 'danger', 'neutral']).default('neutral'),
});
export type AlertAction = z.infer<typeof AlertActionSchema>;

export const AlertSchema = z.object({
  id: z.string().min(1),                          // stable id (server row id, or a client-minted uuid)
  kind: z.string().min(1),                        // discriminator → declared in ALERT_KINDS (below)
  severity: AlertSeveritySchema,
  source: z.enum(['server', 'client']),           // provenance (drives store aggregation + dismiss routing)
  title: z.string().min(1),
  message: z.string(),                            // human copy ("[agent] wants to make ~430 writes: …")
  createdAt: z.number().int().nonnegative(),      // ms epoch
  dismissible: z.boolean().default(true),
  expiresAt: z.number().int().nonnegative().nullable().default(null),  // optional TTL; null = sticky
  // Actionable payload — omitted/[] for passive alerts. `targetId` is the opaque handle the action route
  // needs (e.g. the writeApproval row id); the client never interprets it, it just echoes it to the href.
  actions: z.array(AlertActionSchema).default([]),
  targetKind: z.string().nullable().default(null),  // 'writeApproval' | 'storage' | ...
  targetId: z.string().nullable().default(null),
});
export type Alert = z.infer<typeof AlertSchema>;
```

**Why these fields.** `id`/`kind`/`severity`/`source`/`title`/`message`/`createdAt`/`dismissible`/`expiresAt`
are the common denominator every alert needs. `actions`+`targetKind`+`targetId` are the *actionable*
extension: a passive alert leaves `actions:[]` and renders as a warning strip; an actionable alert carries
`[{id:'approve'},{id:'deny'}]` and a `targetId` the Approve route needs. Keeping actions **data** (not code)
means the banner renders any actionable alert without per-consumer branching — it POSTs `{alertId, actionId}`
to a single generic action endpoint that dispatches on `targetKind` server-side (§6).

**Boundary discipline.** `AlertSchema` is NOT `.strict()` on the *response* path (matching `SyncPullResponse`,
which strips unknowns) so a future field is forward-compatible. The generic action **request** IS `.strict()`
(it's a client→server write; validate hard at the boundary — `packages/worker/src/http.ts` guard `safeParse`).

### 3.2 Declaring a new alert kind = a registry entry, not surface surgery

Mirror the `PLUGIN_AGENT_TOOLS` aggregation seam (`packages/shared/src/mcp/agentTools.ts:118-139`): a small
declarative registry the banner consults for per-kind presentation, and the worker consults for per-kind action
dispatch. Adding a kind appends one entry — no edit to the host component.

```ts
// packages/shared/src/api/alert.ts   (continued)
export interface AlertKindDef {
  kind: string;                                   // matches Alert.kind
  /** Default icon/accent hint for the banner (kept declarative; the host maps it to an existing icon). */
  glyph: 'agent' | 'storage' | 'info' | 'warning';
  /** For actionable kinds: the server target this kind's actions dispatch to (worker binds a handler). */
  targetKind?: string;                            // 'writeApproval' | 'storage' | null for passive
}

export const ALERT_KINDS: readonly AlertKindDef[] = [
  { kind: 'agent.writeApproval', glyph: 'agent', targetKind: 'writeApproval' }, // Consumer #1 (actionable)
  { kind: 'storage.quota',       glyph: 'storage' },                            // Consumer #2 (passive)
];

export function findAlertKind(kind: string): AlertKindDef | undefined {
  return ALERT_KINDS.find((k) => k.kind === kind);
}
```

The worker keeps a parallel `ALERT_ACTION_HANDLERS: Record<targetKind, handler>` map (worker-resident, since
handlers need `db`/`env`) — exactly how `agentTools.ts` splits the declarative wire-shape (shared) from the
runtime `execute` (worker). A new actionable alert kind = one `ALERT_KINDS` entry + one handler registration.

---

## 4. Producers / sources + the server→client (sync-pull) carrier

Two provenances, one client store:

### 4.1 Server-originated (agent approval, storage warning) — rides the existing sync-pull

**Carrier: a new `alerts` array on `SyncPullResponse`** (`packages/shared/src/api/sync.ts:214-221`). Today the
pull response carries `notes`, `notebooks`, `dictionaryWords`, `nextCursor`, `hasMore`. Add:

```ts
// packages/shared/src/api/sync.ts   (add near line 213)
import { AlertSchema } from './alert.js';
// … inside SyncPullResponseSchema (line 214):
export const SyncPullResponseSchema = z.object({
  notes: z.array(SyncNoteSchema),
  notebooks: z.array(SyncNotebookSchema).default([]),
  dictionaryWords: z.array(SyncDictionaryWordSchema).default([]),
  alerts: z.array(AlertSchema).default([]),          // ← NEW: server-active alerts for this account+token
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
```

**Why this does NOT weaken the sync contract:**

1. **Additive, default-`[]`.** An old client that predates the field is unaffected — the pull response is a
   plain `z.object` (no `.strict()`, `sync.ts:214`) and the client does not even validate the pull; it
   type-casts (`syncEngine.ts:438`). Unknown/absent fields never 400 a batch. This is the identical, proven
   path by which `notebooks` and `dictionaryWords` were added to the same response.
2. **Alerts are a CURRENT-STATE PROJECTION, not a CAS/syncSeq stream entity — my recommended design.** Notes /
   notebooks / dictionary words are cursor-paged over the per-account `syncSeq` stream and merged with
   tombstone + pending-edit guards (`dexieLocalStore.ts:298-363`). Alerts don't need any of that: an alert is
   *ephemeral current state* ("what should be showing right now for this account+token"), not durable
   versioned history. So the server computes `alerts` **fresh on every pull** — the set of active, undismissed
   approvals + active status alerts for `(accountId, requesting-token)` — and returns it OUTSIDE the cursor
   window (it does not advance `nextCursor`, does not touch `pullSince`). The client **replaces** its alert set
   from this array each pull (last-writer-wins on the projection), so a resolved/expired alert simply stops
   appearing and drops off. This is the smallest possible change: no new Dexie table, no merge code, no
   syncSeq arm in `pullSince` (`packages/worker/src/db/mutate.ts:446-455` is untouched).
   - *Alternative considered (rejected for v1):* make alerts a first-class syncSeq entity with `deletedAt`
     tombstones like `dictionaryWords`, so dismissal syncs across devices via the stream. That buys
     cross-device dismiss-sync but costs a Dexie table (`version(9)`), a `pullSince` union arm, and merge/
     tombstone code. **Recommendation:** ship the projection; alerts are low-volume and single-user (Jim), and
     dismissal is naturally re-derivable server-side (a dismissed approval is `resolved`, a cleared storage
     warning is recomputed gone). Revisit only if cross-device dismiss-persistence is actually wanted.

**Server assembly point:** `packages/worker/src/routes/sync.ts:230-236` (the pull handler's `c.json({…})`).
Add `alerts: await getActiveAlerts(db, accountId, callerGrantId(principal))` to the returned object.
`getActiveAlerts` unions (a) pending, unresolved `writeApproval` rows for the caller's token → actionable
alerts, and (b) computed status alerts (storage) → passive alerts. It reads nothing the caller doesn't own
(accountId is server-derived, `sync.ts:228`), so isolation is inherited.

### 4.2 Client-originated / local

For purely-local notices (e.g. an optimistic "you're offline — changes will sync" or a client-only nudge), a
producer calls `showAlert({...})` on the store directly (no network). These carry `source:'client'` and are
dismissed locally. The store aggregates both provenances into one ordered list the banner renders.

### 4.3 The unified client alert store (`packages/client/src/lib/alertStore.ts`, new)

A sibling of `toastEvents.ts` — same pub/sub bones, durable lifecycle:

```ts
// packages/client/src/lib/alertStore.ts   (NEW — mirrors toastEvents.ts:24-71)
import type { Alert } from '@deltos/shared';

const _listeners = new Set<(alerts: readonly Alert[]) => void>();
let _server: Alert[] = [];   // last projection from sync-pull (replaced wholesale each pull)
let _local: Alert[] = [];    // client-originated alerts (added/removed individually)
const _dismissed = new Set<string>();  // ids the user dismissed this session (client-side hide)

function _notify() {
  const merged = [..._server, ..._local]
    .filter((a) => !_dismissed.has(a.id))
    .sort(bySeverityThenRecency);          // §5.2 priority
  _listeners.forEach((fn) => fn(merged));
}

/** Called by syncEngine after each pull — REPLACES the server projection wholesale (§4.1). */
export function setServerAlerts(alerts: Alert[]): void { _server = alerts; _notify(); }
/** Local producer API (client-originated notice). */
export function showAlert(a: Alert): void { _local = [..._local, a]; _notify(); }
/** User dismiss — hides client-side; for server actionable alerts the ACTION (approve/deny) resolves it
 *  server-side so it stops projecting on the next pull. */
export function dismissAlert(id: string): void { _dismissed.add(id); _local = _local.filter(x => x.id !== id); _notify(); }
export function subscribeAlerts(fn: (a: readonly Alert[]) => void): () => void { _listeners.add(fn); fn(currentAlerts()); return () => _listeners.delete(fn); }
export function currentAlerts(): readonly Alert[] { /* merged+filtered+sorted snapshot */ }
```

**Wiring into pull:** one line in `syncEngine.ts` after the existing merges (`syncEngine.ts:440-442`):
`setServerAlerts(json.alerts ?? []);` — mirrors `mergeNotebooks(json.notebooks)` /
`mergeDictionary(json.dictionaryWords)`.

---

## 5. The banner surface

### 5.1 Placement (both shells) — and why an actionable alert is NOT hidden inside a closed menu

Jim's phrase was "a banner at the top of the menu." I recommend a refinement, and here is the reasoning:

- A **passive** status alert (storage warning) can live quietly — a top strip is fine; it's informational.
- An **actionable** approval alert must be **noticed and reachable without opening a menu**. If it only lived
  inside the closed `ContextMenuSheet` ("…" menu), the agent's blocked import would stall invisibly until Jim
  happened to open that menu. That defeats the point.

**Recommendation:** the `AlertBanner` host is a **top-of-shell strip**, always mounted, rendering `null` when
empty — the same posture as `ToastHost`. It sits directly under the top bar so it reads as chrome, not content:

- **Mobile shell (`App.tsx`):** mount `<AlertBanner />` immediately after `<header className="shell__bar">`
  closes (i.e. right after `App.tsx:693`), inside `.shell`, before `<main className="shell__main">`
  (`:695`). It pushes the list/editor down when present. For the full-window note view (`App.tsx:540-558`) and
  probe view, leave it OUT (those are deliberately chromeless).
- **Desktop shell (`ThreeRegionShell.tsx`):** the 3-region shell has no global top bar (each region carries
  its own chrome, `ThreeRegionShell.tsx:44-99`). Mount `<AlertBanner />` as a full-width strip **above** the
  `.shell-3region` grid — i.e. wrap the returned tree so the banner spans nav+list+note. Concretely: in
  `App.tsx:576-587` (the `isDesktop` branch) render `<><AlertBanner /><ThreeRegionShell …/>…</>` so the strip
  sits above the three columns. (Mounting it here, in the desktop branch of `App.tsx` alongside the existing
  `ConflictToastHostSlot`/`UploadProgressHost`, keeps it in the ONE place both shells' hosts already live.)

> **Both-shells trap (explicit).** There is a known trap where a host added to one shell is silently missing
> from the other. The acceptance check (§9) mounts BOTH the mobile shell (`App.tsx` AuthedShell mobile branch)
> AND the desktop `ThreeRegionShell` and asserts the banner renders in each. The single safest mount is
> **`App.tsx` in each device branch** (mobile: after the header; desktop: wrapping `ThreeRegionShell`),
> because that file already owns the host-mount slots for both shells (`App.tsx:580` desktop, `:748` mobile) —
> so there is one file to get right, not two.

- **Actionable detail = the lazy sheet.** Tapping an actionable alert's row (or its "Review" affordance) opens
  a `React.lazy` `<ApprovalSheet />` built on the `ContextMenuSheet` overlay language (backdrop-blur,
  `role="dialog"`, Escape/backdrop dismiss, thumb-zone Approve/Deny). The inline banner shows the one-line
  summary + Approve/Deny; the sheet shows the full reason + scale + the count/time box being granted. On a
  read-only day this chunk never loads.

### 5.2 Priority / stacking

Multiple active alerts sort by **severity desc, then recency desc** (`critical` > `warning` > `info`; newest
first within a severity). The banner shows the **top alert as a full strip**; if more than one is active it
shows a "+N more" affordance that expands the stack (reuse the sheet). Rationale: one prominent strip protects
the perf/quiet north-star; a stack of strips would shove the whole app down. Actionable alerts always
out-rank passive ones of equal severity (tie-break: `actions.length > 0` wins) so an approval never hides
behind a storage notice.

### 5.3 Actionable vs passive rendering

- **Passive** (`actions: []`): a severity-tinted strip — glyph + title + message + (if `dismissible`) an ×.
  Reuses the theme tokens (`--paper`/`--border`/severity accent) and the `toast-in` animation.
- **Actionable** (`actions.length > 0`): the strip carries inline buttons per `action` (`Approve` primary,
  `Deny` danger) + a "Review" that opens the lazy sheet. Buttons POST `{alertId, actionId}` to the generic
  action endpoint (§6); on success the alert resolves server-side and drops off the next pull.

### 5.4 Dismiss

- Passive dismiss = client-side hide (`dismissAlert(id)`), and — for a recomputed status alert — it will not
  re-appear until the condition re-crosses the threshold (server recomputes; storage under 95% → gone).
- Actionable "dismiss" is **Deny** (or Approve): the action resolves the underlying `writeApproval` row
  server-side, so it stops projecting. There is no silent client-only dismiss of an approval request (that
  would strand the agent waiting) — closing the sheet just collapses it; the alert stays until acted on.

### 5.5 Lazy / off-first-load posture (perf north-star)

- The `alertStore.ts` module is tiny (pub/sub + an array) — safe in the entry bundle like `toastEvents.ts`.
- `<AlertBanner />` renders `null` when empty (`currentAlerts().length === 0`) — zero DOM, zero cost on a
  normal day. Same idiom as `ToastHost.tsx:37` / `UploadProgressHost.tsx:18`.
- The **only** heavy dependency (the approval sheet) is `React.lazy` — loaded on first "Review", precached by
  the SW thereafter ([[plugins-lazy-past-first-paint]] posture).
- **No new network.** Server alerts arrive on the ~2s visible-only pull already running
  (`syncEngine.ts:662,711`); there is no new poll and nothing on the hot render path.

---

## 6. Consumer #1 — agent bulk-write approval (FULL spec)

### 6.1 The problem this solves

The `mcpWrite` daily cap is **100/account/UTC-day** (`packages/worker/src/abusePolicy.ts:37`), charged
fail-closed at the single write chokepoint after authorization, before mutation
(`packages/worker/src/routes/mcp.ts:236-244`) via the atomic guarded upsert
`chargeUsage(accountId,'mcpWrite',dayBucket,DAILY_QUOTA.mcpWrite,now)` (impl
`packages/worker/src/db/authStore.ts:1631-1651`, table `usageCounter` migration 0016). That low cap is an
**injection blast-radius guard** — deliberately low so a prompt-injected write flood is bounded to ~100
individually-recoverable writes. But a *legitimate* bulk import (~430 writes) trips it. We want the agent to be
able to **ask** for headroom, and the human to grant it **after seeing scale + intent**.

**Design principle (the injection defence):** the agent can only *request*; it cannot self-approve. The human
sees `count` + `reason` before granting. Approval is **scoped to the requesting token** (not the account, so a
second token can't ride it), and **bounded in both count and time** (auto-reverts to 100). This is NOT a
proposal/approval queue for the writes themselves — writes still apply live (per `docs/design/write-tools.md`
§0, the proposal-queue model was explicitly dropped); it is a **quota-lift request**.

### 6.2 D1 table — migration `0023_write-approval.sql`

```sql
-- packages/worker/migrations/0023_write-approval.sql   (NEW; next free number after 0022)
CREATE TABLE writeApproval (
  id           TEXT PRIMARY KEY,            -- server-minted uuid; the alert.targetId + action target
  accountId    TEXT NOT NULL,               -- owner account (server-derived; BOLA read-filter key)
  tokenGroupId TEXT NOT NULL,               -- the REQUESTING token (grant-set id) — approval is token-scoped
  requestedCount INTEGER NOT NULL,          -- how many extra writes the agent asked for (~430)
  reason       TEXT NOT NULL,               -- agent-supplied intent, shown to the human (capped length)
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied' | 'expired'
  grantedCount INTEGER,                     -- extra writes actually granted (== requestedCount on approve)
  approvedAt   INTEGER,                     -- ms epoch of approval
  windowDayBucket TEXT,                     -- the UTC day the extra applies to (approval is time-boxed to a day)
  createdAt    INTEGER NOT NULL,            -- ms epoch of the request
  expiresAt    INTEGER NOT NULL             -- pending requests self-expire (e.g. createdAt + 30 min)
);
CREATE INDEX idx_writeApproval_account ON writeApproval (accountId, status);
CREATE INDEX idx_writeApproval_token   ON writeApproval (tokenGroupId, status, windowDayBucket);
```

**Token identity:** the requesting token is identified by `tokenGroupId` (stable across per-resource
revocation; falls back to `grantId` for single-row grants) — exactly the key the MCP rate-limit already uses
(`packages/worker/src/routes/mcp.ts:107-114`) and that `credentialRefOf(principal)` surfaces for audit
(`packages/worker/src/audit.ts:67-71`). So "scoped to the requesting token" reuses an existing, proven handle.

### 6.3 MCP tools (two new, both READ-scope)

Both slot into the `MCP_TOOLS` registry via `defineTool` (`packages/worker/src/mcp/tools.ts:255`) and are
declared with an `op` that is **NOT in `WRITE_OPS`** (`tools.ts:71` = `{create,write,delete}`), so they:
(a) do not consume the `mcpWrite` cap, and (b) are available to any live token (a read-only token can still
*ask*; asking is harmless). Use `op:'read'` (workspace resource).

- **`request_write_approval({ count, reason })`** → validates (`count` positive int, `reason` non-empty,
  length-capped), inserts a `writeApproval` row `{status:'pending', tokenGroupId: callerToken, expiresAt:
  now+30min}`, audits (`surface:'mcp', action:'approval.request', principalKind:'agent', detail: count+reason`),
  and returns `{ approvalId, status:'pending' }`. **It does NOT block** — the write that tripped the cap has
  already errored; the agent calls this, tells the user in chat, and polls.
- **`check_write_approval({ approvalId })`** → returns `{ status, grantedCount? }` for the caller's own token
  (BOLA: `WHERE tokenGroupId = callerToken AND id = ?`). The agent polls this cheaply to learn Approve/Deny,
  then retries its writes. This is the "how does the agent learn it was approved" answer: a cheap read tool,
  no server push needed.

Both tools' descriptions are authored as `AgentToolDef`-style prose so the model knows to reach for them when
it hits `daily write limit reached` (`mcp.ts:240`).

### 6.4 REST — the human Approve/Deny (generic alert-action endpoint)

One generic, account-scoped, guarded endpoint handles all actionable alerts (dispatch on `targetKind`):

`POST /api/alerts/:id/action` — body `{ actionId: 'approve' | 'deny' }`, guarded by the standard `guard()`
chokepoint (`packages/worker/src/http.ts` — validates, resolves principal, per-principal rate-limit, `can()`,
audits, then `handle`). Pattern mirror: `packages/worker/src/routes/agentTokens.ts:45-64` and
`routes/account.ts` account-scoped handlers.

- **op:** `'share'` (owner-only workspace op — the same op the token-mint + connected-apps routes use;
  the human owner holds `share` over their workspace, `agentTokens.ts:57-60`).
- **account scoping / BOLA:** `accountId = stampAccountId(principal)` (server-derived, never body,
  `agentTokens.ts:63-64`); the handler updates `writeApproval` `WHERE id=? AND accountId=?` so one account can
  never act on another's approval. Resource = `{kind:'workspace'}`.
- **Approve handler** (`targetKind:'writeApproval'`): CAS the row `pending → approved`, set
  `grantedCount=requestedCount`, `windowDayBucket = dayBucket(now)` (`abusePolicy.ts:60`), `approvedAt=now`.
  Audit `surface:'auth', action:'approval.grant', principalKind:'owner', credentialRef, detail: approvalId+count`
  — projects to the D1 `auditLog` trust-surface (`audit.ts:86-88` projects everything non-`rest`).
- **Deny handler:** CAS `pending → denied`; audit `action:'approval.deny'`.
- **Step-up?** NOT required here. The acting principal is the authenticated owner in a live session, physically
  looking at the scale+intent — which IS the control. Step-up (`verifyStepUp`, `packages/worker/src/stepUp.ts:36`)
  is warranted at *mint/consent* time (no human present at write time); at approval time the human IS present.
  (If Jim wants belt-and-braces, step-up can be added to Approve only — cheap, but I recommend against it as
  friction on a same-session tap. See open questions.)

### 6.5 Effective-cap wiring (the one chokepoint change)

The ONLY change to the hot write path is at `packages/worker/src/routes/mcp.ts:237`. Replace the constant cap
with a per-token effective cap:

```ts
// mcp.ts — at the write chokepoint (currently line 237)
if (WRITE_OPS.has(tool.op)) {
  const effCap = await effectiveWriteCap(store, accountId, callerTokenGroupId(principal), dayBucket(Date.now()));
  const cap = await store.chargeUsage(accountId, 'mcpWrite', dayBucket(Date.now()), effCap, now);
  if (!cap.allowed) { /* unchanged: return toolError('daily write limit reached …') */ }
}
```

```ts
// packages/worker/src/usage.ts (or a sibling) — NEW
export async function effectiveWriteCap(store, accountId, tokenGroupId, day): Promise<number> {
  // base 100 + the approved, time-boxed extra for THIS token on THIS day (0 if none).
  const extra = await store.approvedWriteExtra(accountId, tokenGroupId, day); // SUM(grantedCount) WHERE status='approved' AND windowDayBucket=day AND tokenGroupId=?
  return DAILY_QUOTA.mcpWrite + extra;
}
```

**Boxing properties (both enforced by the query):**
- **Count-boxed:** the effective cap = `100 + Σ grantedCount`. Once the counter reaches it, writes 429 again.
  The extra is a *ceiling raise*, not a bypass — every write still charges `usageCounter` atomically
  (`authStore.ts:1631-1651`), so it can never exceed the granted headroom even under a burst.
- **Time-boxed:** `windowDayBucket` pins the approval to ONE UTC day. Tomorrow's `dayBucket` doesn't match, so
  `approvedWriteExtra` returns 0 → the cap **auto-reverts to 100** with no cleanup job. (The nightly prune
  that already reaps `usageCounter`/`auditLog`, `abusePolicy.ts:52-53` + `index.ts:422`, can also reap old
  `writeApproval` rows; not required for correctness.)
- **Token-boxed:** keyed on `tokenGroupId`, so approving token A's import does not lift token B's cap.

### 6.6 Security properties (summary)

1. **Agent can only ask.** `request_write_approval` merely inserts a `pending` row; it grants nothing. The
   human's Approve is the only path to extra quota. Injection that reaches the tool can request, not self-grant.
2. **Human sees scale + intent.** The alert renders `count` + `reason` verbatim before Approve is possible.
3. **Scoped to the requesting token**, not the account (`tokenGroupId` key) — a second/rotated token starts
   fresh at 100.
4. **Count- AND time-boxed, auto-reverting** (§6.5) — a granted lift can't become a standing bypass.
5. **BOLA-safe** — approval read/act filters on server-derived `accountId`; cross-account is invisible
   (inherits the isolation model `mcp.ts:227-229`).
6. **Non-repudiable audit** — request, grant, deny all hit the append-only AE dataset + the D1 `auditLog`
   projection surfaced in "Account activity" ([[surface-audit-log-as-live-trust-surface]]).
7. **Writes still apply live** — this is a quota-lift, not a proposal queue; recoverability (versions + trash)
   is unchanged (`write-tools.md` §0).

---

## 7. Consumer #2 — storage warning (DESIGN-FOR, do NOT build) — the "it just slots in" proof

A passive **"storage at 95% of 10 GB"** warning proves the model is generic. It touches **zero new surface
code** — only a producer.

- **Where it's produced (server).** The R2 byte sizer already exists: `accountUsage(bucket, accountId)`
  (`packages/worker/src/blobStore.ts:61-70`) walks `${accountId}/` and sums `obj.size`. A cheap check computes
  `used / QUOTA` against the account blob quota (the same `ACCOUNT_BLOB_QUOTA` guard referenced in
  `abusePolicy.ts:30`). This runs where the pull assembles alerts — i.e. inside `getActiveAlerts`
  (`sync.ts:230`), or (cheaper) on the existing nightly `scheduled` cron (`index.ts:422`) that already sweeps
  usage, caching the ratio so the hot pull just reads a number. Recommendation: compute on write (after an
  upload) + on cron; the pull just reads the cached ratio — no per-pull R2 `list()`.
- **How it rides the same carrier.** When `used ≥ 0.95 * quota`, `getActiveAlerts` includes:
  ```jsonc
  { "id": "storage.quota", "kind": "storage.quota", "severity": "warning", "source": "server",
    "title": "Storage almost full",
    "message": "Storage is at 95% of your 10 GB limit.",
    "dismissible": true, "expiresAt": null, "actions": [], "targetKind": null, "targetId": null }
  ```
  It flows through the **exact same** `alerts` array on `SyncPullResponse` (§4.1), the **exact same**
  `setServerAlerts` client wiring (§4.3), and the **exact same** `<AlertBanner />` host (§5).
- **How it renders.** `actions: []` → the banner renders it as a passive warning strip (§5.3): storage glyph
  (declared once in `ALERT_KINDS`), title, message, × to dismiss. No sheet, no REST action, no MCP tool.
- **Lifecycle.** When usage drops back under threshold, the next `getActiveAlerts` omits it → the projection
  no longer contains it → it drops off the banner automatically (§4.1 wholesale-replace). A stable id
  (`"storage.quota"`) means it de-dupes naturally across pulls.

Total new code to add this later: **one `ALERT_KINDS` entry + one branch in `getActiveAlerts`.** No schema
change, no client change, no surface change. That is the proof.

---

## 8. Reuse map (reuse what vs new)

| Piece | Reuse | New |
|---|---|---|
| Client alert store | The `toastEvents.ts` pub/sub *pattern* (`_items`+`_listeners`+`subscribe`) | `lib/alertStore.ts` (durable lifecycle, server+local aggregation) |
| Banner host mount | The `ToastHost`/`UploadProgressHost` null-render + static-import posture; the `App.tsx` host-mount slots (`:580`, `:748`) | `components/AlertBanner.tsx` (top strip, both shells) |
| Actionable detail sheet | The `ContextMenuSheet` overlay language (backdrop-blur, `role=dialog`, Escape/backdrop dismiss, thumb-zone buttons) | `components/ApprovalSheet.tsx` (`React.lazy`) |
| Server→client carrier | The `SyncPullResponse` shape + the additive-field-is-safe property (`notebooks`/`dictionaryWords` precedent); `syncEngine.ts:440-442` merge site | `alerts` array field + `setServerAlerts` one-liner |
| Alert schema | zod-in-`@deltos/shared` boundary discipline | `api/alert.ts` (`AlertSchema`, `ALERT_KINDS`, `AlertActionSchema`) |
| Kind declaration seam | The `PLUGIN_AGENT_TOOLS` aggregate-registry pattern (`agentTools.ts:118-139`) | `ALERT_KINDS` + worker `ALERT_ACTION_HANDLERS` |
| MCP tools | `defineTool` + `MCP_TOOLS` registry (`tools.ts:255`), read-op = free of write cap (`WRITE_OPS`, `tools.ts:71`) | `request_write_approval`, `check_write_approval` |
| Quota chokepoint | The atomic `chargeUsage` guard + `usageCounter` (`authStore.ts:1631-1651`); `dayBucket` (`abusePolicy.ts:60`) | `effectiveWriteCap` + `approvedWriteExtra`; one-line swap at `mcp.ts:237` |
| Approve/Deny REST | The `guard()` chokepoint + `stampAccountId` BOLA pattern (`agentTokens.ts:45-64`) | `POST /api/alerts/:id/action` + `writeApproval` handlers |
| Token identity | `tokenGroupId` (rate-limit key `mcp.ts:107`) / `credentialRefOf` (`audit.ts:67`) | — (reused as the approval scope key) |
| Audit | `audit()` + AE + D1 `auditLog` projection (`audit.ts:100-123`); trust-surface | new `action` strings: `approval.request/grant/deny` |
| D1 table | migration conventions (`NNNN_kebab.sql`, never rewrite applied) | `0023_write-approval.sql` |
| Storage sizer | `accountUsage` (`blobStore.ts:61`) | one branch in `getActiveAlerts` (Consumer #2, later) |

---

## 9. Build plan — ordered lanes (each one-agent-sized, each with acceptance + perf gate + rendered-UI gate)

Perf gate (applies to EVERY lane touching the client): the shell entry bundle must not grow meaningfully; the
`AlertBanner` host renders `null` when empty; the approval sheet is `React.lazy` (assert it is NOT in the entry
chunk). Rendered-UI gate (UI lanes): a mount test that renders the routed tree (BOTH shells) and asserts DOM,
plus a thin on-device smoke on the live site ([[ui-features-need-rendered-ui-gate]]).

- **Lane 1 — shared schema + kind registry** (`@deltos/shared`).
  - Build: `api/alert.ts` (`AlertSchema`, `AlertActionSchema`, `AlertSeveritySchema`, `ALERT_KINDS`,
    `findAlertKind`); add `alerts: z.array(AlertSchema).default([])` to `SyncPullResponseSchema`
    (`sync.ts:214`); export from `api/index.ts`.
  - Accept: unit tests — `AlertSchema` round-trips; an OLD `SyncPullResponse` (no `alerts`) still parses (proves
    additive-safe); a strict action-request schema rejects unknown fields. Prod `tsc` clean
    ([[green-gate-needs-prod-typecheck]]).
- **Lane 2 — client alert store + banner host + both-shell mount** (client, no server yet).
  - Build: `lib/alertStore.ts`; `components/AlertBanner.tsx` (passive rendering only for now); mount in
    `App.tsx` mobile branch (after `:693`) AND desktop branch (wrapping `ThreeRegionShell`, `:576-587`).
    Feed it via a local `showAlert` test hook.
  - Accept: mount test renders the MOBILE shell and asserts the banner appears when the store has an alert and
    is absent (`null`) when empty; a SECOND mount test does the same for the DESKTOP `ThreeRegionShell` path
    (closes the both-shells trap). Perf: assert `AlertBanner` chunk is in entry but sheet is not.
- **Lane 3 — sync-pull carrier wiring** (server + client).
  - Build: `getActiveAlerts(db, accountId, tokenGroupId)` (returns `[]` for now); add `alerts:` to the pull
    handler `c.json` (`sync.ts:230-236`); add `setServerAlerts(json.alerts ?? [])` after the merges in
    `syncEngine.ts` (`:440-442`).
  - Accept: worker test — pull response includes `alerts:[]`; a stubbed active alert appears in the response
    for the owning account only (isolation). Client test — a pull with an alert lands in the store and renders.
- **Lane 4 — write-approval backend** (worker + migration).
  - Build: migration `0023_write-approval.sql`; store methods (`insertWriteApproval`, `getWriteApproval`,
    `setApprovalStatus` (CAS), `approvedWriteExtra`); `effectiveWriteCap`; swap the cap at `mcp.ts:237`;
    `getActiveAlerts` emits pending approvals as actionable alerts.
  - Accept: unit — approve lifts the effective cap by `grantedCount` for the day and ONLY for that
    `tokenGroupId`; a different day / different token still caps at 100 (count+time+token boxing); atomic
    `chargeUsage` never exceeds the effective cap under a concurrent burst
    (mirror `d1-rowswritten` / atomic-charge tests). Isolation — cross-account act is rejected.
- **Lane 5 — MCP tools** (worker + shared prose).
  - Build: `request_write_approval`, `check_write_approval` in `MCP_TOOLS` (read op, free of write cap);
    descriptions teach the model to reach for them on `daily write limit reached`.
  - Accept: unit — a read-only token CAN call `request_write_approval` (asking is harmless); the tool does not
    charge `mcpWrite`; `check_write_approval` returns status for the caller's token only (BOLA).
- **Lane 6 — Approve/Deny REST + actionable banner + lazy sheet** (worker + client).
  - Build: `POST /api/alerts/:id/action` (guard, op `share`, BOLA, audit `approval.grant/deny`);
    `ALERT_ACTION_HANDLERS['writeApproval']`; actionable banner rendering (inline Approve/Deny + Review);
    `React.lazy` `ApprovalSheet` on `ContextMenuSheet` bones.
  - Accept: mount test — an actionable alert renders Approve/Deny; clicking POSTs and (mocked) resolves;
    the sheet is a separate lazy chunk. Perf gate re-checked. On-device smoke on live: mint a write token,
    trip the cap, agent requests, alert shows scale+reason, Approve lifts, agent retries succeed.
- **Lane 7 (LATER, not now) — storage warning producer.** One `ALERT_KINDS` entry (already present) + one
  branch in `getActiveAlerts` reading the cached storage ratio. Proves generality; not built in this pass.

Suggested parallelism: Lane 1 first (everyone depends on it). Then Lane 2 and Lane 4 can run in parallel
(client surface vs server quota). Lane 3 needs 1. Lanes 5–6 need 4 (+ 1,2). Each lane is one-agent-sized.

---

## 10. Open questions for Jim (each with my recommendation)

1. **Alerts as a fresh projection vs a synced entity with tombstones?** A projection (recomputed each pull,
   replaced wholesale) is far less code — no Dexie table, no merge/tombstone machinery — but a *dismiss* is
   client-session-local (it re-appears on a new device until the underlying condition clears/resolves). A
   synced entity persists dismissal across devices at the cost of a table + merge arm. **My recommendation:
   projection.** You're the only user, alerts are low-volume, and every alert's dismissed-ness is naturally
   re-derivable server-side (approved/denied approval, storage back under threshold). Revisit only if
   cross-device dismiss-persistence actually bites.
2. **Banner placement — top strip vs inside the "…" menu?** You said "banner at the top of the menu," but an
   *actionable* approval hidden inside a closed menu would stall the agent invisibly. **My recommendation: a
   top-of-shell strip** (both shells), always visible when active, with the full Approve/Deny detail in a lazy
   sheet. Passive status alerts live in the same strip. If you specifically want passive alerts tucked into the
   "…" menu and only actionable ones as a strip, that's a small rendering fork — say the word.

**(Also noted, lower-stakes, proceeding on my judgment unless you object):** approval Approve requires no
step-up re-auth (you're present in-session looking at scale+intent — that IS the control; step-up stays at
mint/consent time); pending approvals self-expire after 30 min; the effective-cap grants exactly the requested
count for exactly one UTC day, auto-reverting to 100.
