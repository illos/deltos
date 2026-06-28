# Direct-to-R2 Upload (large file notes) — Design + Build Spec

**Status:** DESIGN → BUILD-READY (approach settled by Jim; this is the done-gate for the
build that follows).
**Date:** 2026-06-28.
**Depends on:** the `blob` host capability + file-notes feature (`file-notes.md`) — the
content-addressed R2 store (`{accountId}/{hash}`), the authenticated blob GET, `blobClient`,
and `createFileNote` are all **BUILT + live**. See `routes/blob.ts` (the current buffered
upload this *augments*, never replaces) and `file-notes.md` §5.1 (the `createFileNote` path
that gains size-based routing).
**Approach:** SETTLED by Jim — for **large files only**, the client uploads **directly to
R2** via a short-lived **presigned PUT URL**, bypassing the Worker for the bytes. The Worker
**authorizes** (signs the URL, scoped to exactly one key) and **records** (confirms +
quota); it never buffers the file. Integrity is enforced by **R2's own SHA-256 checksum
validation**, not by the Worker hashing bytes.
**Scope gate (HARD):** this path is reachable **only from file-note creation** (`createFileNote`).
Inline editor attachments (drag/paste into the editor — `attachmentDrop.ts`) are **completely
untouched**: same buffered `POST /api/plugin/blob`, same ~25 MB cap.
**New infra:** **no new binding** — but two new Worker **secrets** (an R2 S3-API token) and a
one-time **R2 bucket CORS** policy that Jim provisions (§5). No schema / migration / sync change.

---

## 0. The one-line thesis

The current upload buffers the **whole file in the Worker** to hash-verify it
(`routes/blob.ts:140`, `c.req.arrayBuffer()`), so it is bounded by the **128 MB Worker
memory** budget and the **~100 MB Cloudflare request-body limit**. Jim has a **101 MB PDF**
(and bigger coming) that cannot go this way. The fix, **gated to file notes only**: a file
larger than a threshold is uploaded **straight from the browser to R2** over a presigned PUT
URL the Worker signs for **exactly `{accountId}/{clientHash}`**. The bytes never touch the
Worker. **Three guarantees the buffered path gives, preserved by different means:**

| Property | Buffered path (today) | Direct-to-R2 path (this spec) |
|---|---|---|
| **BOLA** (own-prefix-only) | Worker derives `accountId` from the bearer and builds the key | Worker derives `accountId` from the bearer and **bakes it into the signed key**; the client cannot steer the key |
| **Content-address integrity** | Worker SHA-256s the bytes; mismatch → 400 | **R2** validates `x-amz-checksum-sha256` (a *signed* header bound into the URL) on receipt; bytes that don't hash to `clientHash` are **rejected by R2** |
| **Quota + size cap** | checked in-request before `put` | checked **post-hoc** at a `confirm` call (HEAD the object → real size → over-quota ⇒ delete + error) |

Everything **downstream is unchanged**: the object lands at the **same `{accountId}/{hash}`
key**, served by the **same** authenticated blob GET (`attachment` + `nosniff` +
`default-src 'none'; sandbox`), deduped the same way, and read through the same blob cache.
Only the **write** (and the now-skipped WebP bake) differ.

---

## 1. What this IS (and is not)

- **IS:** a size-routed *second upload path* for **file-note creation**. Small files keep the
  existing buffered `uploadBlob`; large files (> threshold) get a presign → direct PUT →
  confirm flow. The resulting note is byte-for-byte the same shape (§2 of `file-notes.md`):
  a `Note` whose body is one attachment block pointing at `{ hash, name, mime, size }`.
- **IS:** Worker-authorized, R2-enforced. The Worker signs a URL scoped to one key + one
  checksum and confirms the result. R2 enforces the content-address. The Worker is never in
  the byte path, so the 128 MB / ~100 MB limits do not apply.
- **IS NOT:** a change to inline attachments. Dragging/pasting a file **into the open editor**
  (`attachmentDrop.ts` → `uploadBlob`) stays on the buffered path with its current ~25 MB
  cap, **byte-for-byte unchanged**. The size router lives **only** in `createFileNote`.
- **IS NOT:** a thumbnail/derivative producer. Anything over the threshold is already over the
  **20 MB `IMAGES` input cap** (`file-notes.md` §4.5), so it never qualified for a WebP bake —
  the direct path simply stores the blob (PDF → format icon; a >20 MB image → no thumbnail,
  the existing icon fallback). **No `env.IMAGES` call on this path.**
- **IS NOT:** a new storage namespace, schema, or sync change. The canonical key, the blob
  GET, dedup, and the cache are all the existing ones.

---

## 2. The routing model — inline vs file-note, and the threshold

### 2.1 Two upload paths, one entry point that routes

```
                       file note creation                inline editor attachment
                       (createFileNote)                  (attachmentDrop → uploadBlob)
                              │                                      │
                file.size ≤ 25 MB │ file.size > 25 MB                │  (always ≤ 25 MB,
                              ▼   ▼                                   ▼   buffered, UNCHANGED)
                    ┌──────────┐  ┌──────────────────────┐    ┌──────────────────────┐
                    │ uploadBlob│ │ uploadBlobDirect      │    │ POST /api/plugin/blob │
                    │ (buffered)│ │ presign→PUT→confirm   │    │ (buffered, hash-verify│
                    │  EXISTING │ │  NEW (this spec)      │    │  + WebP bake)         │
                    └──────────┘  └──────────────────────┘    └──────────────────────┘
                              \         /                              │
                               ▼       ▼                              ▼
                         same {accountId}/{hash} in R2  ◀── same key, same GET, same cache
```

Only **`createFileNote`** gains the `file.size` branch. `attachmentDrop.ts` calls `uploadBlob`
directly and is never modified.

### 2.2 The threshold — **25 MB** (= the current `MAX_BLOB_SIZE`)

**Recommendation: route file notes by the existing 25 MB cap. Files ≤ 25 MB ride the buffered
path entirely unchanged; files > 25 MB ride direct-to-R2.** Rationale:

- **No need to raise the buffered cap.** The boundary already exists (`MAX_BLOB_SIZE =
  25 * 1024 * 1024`). Keeping it means the buffered path's memory/CPU envelope, its hash-verify,
  its dedup, and its WebP bake are all **untouched** — zero risk to the audited path.
- **The bake-eligibility boundary (20 MB `IMAGES` input cap) sits *below* the threshold**, so
  nothing routed to the direct path was ever bakeable. Routing at 25 MB means the direct path
  *never* needs `env.IMAGES`, and the buffered path *always* still bakes the images it can.
- **Inline attachments are naturally excluded** — they call `uploadBlob`, which the Worker still
  caps at 25 MB; an inline attachment can never exceed the threshold, so it can never reach the
  direct path. The router is structurally file-note-only.

Define a single shared constant `DIRECT_R2_THRESHOLD = 25 * 1024 * 1024` (client-side, in the
file-note creation path) so the number lives in one place. It MUST equal the Worker's
`MAX_BLOB_SIZE` (a file at exactly 25 MB takes the buffered path; the first byte over routes
direct) — note the coupling in a comment on both constants.

> The buffered path is technically safe to ~90 MB (well under the 128 MB / ~100 MB limits), but
> deliberately **not** raised: a higher buffered cap still can't reach Jim's 101 MB PDF and
> would only widen the Worker's memory-pressure surface for no gain. The direct path is the
> unbounded answer; the buffered cap stays put.

---

## 3. The direct-to-R2 mechanism (presign → PUT+checksum → confirm)

Three steps. The Worker is in steps 1 and 3 only (no bytes); R2 enforces integrity in step 2.

```
client                              worker (/api/plugin/blob/*)              R2 (S3 API)
  │  1. POST /presign {hash,size,mime}  │                                        │
  │ ───────────────────────────────────▶│  derive accountId from bearer          │
  │                                      │  key = `${accountId}/${hash}`          │
  │                                      │  sign PUT(url, x-amz-checksum-sha256)  │
  │  ◀───────────────────────────────── │  {url, headers, expiresIn}             │
  │                                                                               │
  │  2. PUT url  (body=file, x-amz-checksum-sha256, content-type)                 │
  │ ─────────────────────────────────────────────────────────────────────────── ▶│ validate sig (key+checksum+expiry)
  │                                                                               │ validate SHA-256(body)==checksum
  │  ◀─────────────────────────────────────────────────────────────────────────  │ 200 (ETag)  | 400 BadDigest on mismatch
  │                                                                               │
  │  3. POST /confirm {hash, mime}       │                                        │
  │ ───────────────────────────────────▶│  HEAD `${accountId}/${hash}` → size     │ ──HEAD──▶
  │                                      │  usage+size > quota ⇒ DELETE + 413       │ ──DELETE─▶ (only if over)
  │  ◀───────────────────────────────── │  {hash, size}  (same shape as uploadBlob)│
  │  4. mint the file note (hash,name,mime,size)  →  putNoteAndEnqueue  (unchanged)│
```

### 3.1 `POST /api/plugin/blob/presign` (new authed endpoint)

Mounted on the existing `blob` Hono router (`routes/blob.ts`), reusing `resolveAccountId(c)`
(the same bearer→accountId derivation as every other blob route).

**Request body:** `{ hash: string /* 64-hex SHA-256 */, size: number, mime: string }`.
**Validation (fail-closed):**
1. `accountId = resolveAccountId(c)` — 401 if unauthenticated (same as the buffered route).
2. `hash` MUST match `/^[0-9a-f]{64}$/` — reject anything that isn't a clean SHA-256 (the same
   guard the GET route uses so the key can't be steered).
3. `size` MUST be a positive integer **> `MAX_BLOB_SIZE`** (presign is only for the large path;
   a small-file presign request is a client bug → 400) **and ≤ a sane ceiling** (e.g. an
   `MAX_DIRECT_BLOB_SIZE`, say **2 GB** for v1 — single-PUT regime, §3.4). Over the ceiling → 413.
4. **Cheap pre-flight quota check (advisory):** `accountUsage(BLOBS, accountId)` (the existing
   R2-list sum) + the *declared* `size` > `ACCOUNT_BLOB_QUOTA` ⇒ 413 `quota_exceeded` *before*
   issuing a presign — so an obviously-over-quota upload never even starts. (Declared size is
   client-claimed; the **authoritative** enforcement is the post-hoc HEAD in `confirm`, §3.3.
   This is a courtesy gate that avoids a wasted multi-hundred-MB upload.)

**The signature (THE BOLA + integrity control):**
- `key = `${accountId}/${hash}`` — **the Worker fixes the key**; `accountId` is server-derived
  from the bearer and `hash` is the validated 64-hex. The client supplies neither the prefix nor
  any arbitrary key. A caller can obtain a URL that writes **only** to its own one slot.
- Sign a **PUT** to `https://<accountid>.r2.cloudflarestorage.com/deltos-blobs/<key>` with
  **`x-amz-checksum-sha256` as a *signed* header** whose value is the **base64 of the raw 32
  hash bytes** (the Worker converts the validated hex → bytes → base64 itself, so the signed
  checksum and the key's hash derive from the **same** value — the client cannot decouple them).
  Use **`aws4fetch`** (`AwsClient.sign(url, { method: 'PUT', headers: { 'x-amz-checksum-sha256':
  b64, 'content-type': mime }, aws: { signQuery: true } })`) → a **presigned URL** (SigV4 in the
  query string) whose `X-Amz-SignedHeaders` includes `x-amz-checksum-sha256`. Set
  `X-Amz-Expires` (§3.4 — generous; leakage is harmless because the URL writes only the exact
  pre-chosen content to the caller's own key).
- The credentials are the R2 S3-API token in Worker secrets (`R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`); the endpoint host derives from the `account_id` already in
  `wrangler.jsonc`. Signing is **local** — no network call.

**Response:** `{ url, headers: { 'x-amz-checksum-sha256': b64, 'content-type': mime }, key,
expiresIn }` — the client must PUT to `url` sending **exactly** those headers.

### 3.2 The PUT (client → R2, no Worker)

The client does a **single PUT** of the file bytes to `url` with the returned headers. **R2
rejects the object unless** (a) the signature is valid (correct key, the `x-amz-checksum-sha256`
header present and matching what was signed, not expired) **and** (b) the actual body hashes to
that checksum — `SHA-256(body) === clientHash`. So the only bytes that can ever land at
`{accountId}/{hash}` are bytes that **content-address to `hash`** — the same invariant the
Worker's `crypto.subtle.digest` enforced, now enforced by R2 with the Worker out of the byte
path. A mismatch yields an S3 `BadDigest`/`400`; the client surfaces an error and mints no note.

### 3.3 `POST /api/plugin/blob/confirm` (new authed endpoint)

After a `200` PUT, the client confirms. **Request:** `{ hash, mime }`. The Worker:
1. `accountId = resolveAccountId(c)` (401 if unauthenticated); validate `hash` is 64-hex.
2. `head = BLOBS.head(`${accountId}/${hash}`)` (the existing `BLOBS` binding — no S3 creds
   needed for HEAD/DELETE). **404 `not_found`** if absent (the client claims an upload that
   isn't there — never mint a note for a missing blob).
3. `size = head.size` — **the real, R2-measured size** (not the client's declared one).
4. **Authoritative quota:** `used = accountUsage(BLOBS, accountId)` (the object is already
   counted, since it's in R2). If `used > ACCOUNT_BLOB_QUOTA` ⇒ **`BLOBS.delete(key)`** and
   return **413 `quota_exceeded`** (roll back the just-uploaded object so an over-quota account
   can't keep bytes it wasn't allowed to store). *Dedup edge:* a content-addressed re-upload of
   bytes the account already stored adds **zero** net usage (R2 overwrite of the same key = same
   bytes), so a dedup confirm never trips the rollback on its own; the pre-flight (§3.1) plus
   this post-hoc check cover the honest cases. (Flagged §8.)
5. **No WebP bake** — over 25 MB ⇒ over the 20 MB `IMAGES` cap ⇒ ineligible by construction
   (§1). The confirm path never touches `env.IMAGES`.
6. Return **`{ hash, size }`** — the **identical shape** `uploadBlob` returns, so `createFileNote`
   consumes it the same way regardless of which path produced it.

> **"Recording ownership" = the object existing under `{accountId}/`.** The live system has **no
> blob DB table**; ownership is purely the key prefix and "referenced-ness" is purely whether a
> live note's body points at the hash (exactly as `file-notes.md` §6 already models it). So
> `confirm` records nothing new in a database — it verifies-exists, enforces quota, and returns
> the size. The note minted in step 4 is what marks the blob as *referenced*, client-side, just
> as today. No new table, no migration.

### 3.4 Single PUT vs multipart — **single PUT for v1**

**Recommendation: a single presigned PUT.** It is the simplest robust mechanism and covers an
R2 single-object PUT up to **~5 GB** (the S3 single-PUT ceiling) — comfortably past Jim's
101 MB PDF and the "bigger later" headroom. Cap `MAX_DIRECT_BLOB_SIZE` at **2 GB** for v1 (well
within single-PUT limits; revisit upward as real files demand).

- **Expiry (`X-Amz-Expires`):** set **generously — 1 hour (3600s)**. A 300 MB upload on slow
  cellular can take minutes; the window must comfortably contain the whole transfer. There is
  **no security cost** to a long TTL here: the URL grants write to **exactly one key** with
  **exactly one checksum**, so even a leaked URL can only upload the *identical bytes the user
  already chose* to *their own* slot — a no-op for an attacker (§7).
- **Multipart is needed when** any of: (a) objects exceed **5 GB** (single-PUT ceiling); (b)
  **resumability** matters — a single PUT that drops at 290/300 MB restarts from zero, painful on
  flaky mobile networks; (c) you want bounded memory on the client for truly huge files. Multipart
  adds real surface (initiate → presign-each-part → upload parts in parallel → complete, with the
  Worker brokering each step), so it is **explicitly out of v1** and flagged as the upgrade path
  (§8 OQ-2) for when files routinely exceed a few hundred MB or resumability becomes a felt need.

---

## 4. Integrity, quota, and the orphan window

- **Integrity** — covered above (§3.2): R2's signed-checksum validation makes the content-address
  unforgeable without the Worker seeing bytes. **This is the single load-bearing assumption of the
  whole design**, so it is a hard build gate (§7, DR-INTEGRITY): the build MUST *observe* R2
  **reject** a PUT whose body doesn't match `x-amz-checksum-sha256` (don't take the docs' word —
  prove it against the real bucket).
- **Quota** — pre-flight advisory check at presign (§3.1) + authoritative post-hoc HEAD-and-maybe-
  delete at confirm (§3.3). The authoritative gate is post-hoc because the Worker can't meter bytes
  it never sees; the object is rolled back if it pushed the account over `ACCOUNT_BLOB_QUOTA`.
- **The orphan window** — a client can presign + PUT and then **never confirm** (crash, navigate
  away, malice). The object sits at `{accountId}/{hash}` **unreferenced by any note**. Note this is
  the **exact same orphan class** `file-notes.md` §6 already defines and defers: *"a blob no live
  note references"* — a soft-deleted file note leaves precisely such an orphan today. So an
  unconfirmed direct upload needs **no new machinery**; it is swept by the **same deferred
  orphan-GC** (a later job listing R2 keys under `{accountId}/` with no referencing live note).

  **v1 recommendation (simplest): direct-to-canonical-key + rely on the already-deferred
  orphan-GC**, plus the pre-flight quota courtesy gate. This matches the `pre-real-users-clean-
  state-bias` posture (storage is cheap/disposable; Jim is the only user) and adds zero new
  surface. **Pre-multi-user hardening (HARD before >1 user, mirroring the blob route's deferred
  rate-limit):** either (a) a **staging prefix** — presign to `{accountId}/_staging/{hash}`,
  `confirm` does a server-side **CopyObject** to the canonical `{accountId}/{hash}` then deletes
  the staging object, and an **R2 lifecycle rule** TTLs `_staging/` (e.g. 24h) so unconfirmed
  uploads self-clean automatically; or (b) the orphan-GC sweep made real. (a) buys *automatic* TTL
  cleanup at the cost of a copy on confirm; (b) keeps the canonical-key simplicity. Recommend (b)
  unless pre-confirm orphan abuse becomes real. Flagged §8 OQ-1.

---

## 5. Credentials + CORS — **what Jim provisions** (one-time)

The Worker `BLOBS` binding **does not sign URLs** — presigning needs **R2 S3-API credentials**.
Jim runs these once; the team cannot from the box (no interactive Cloudflare auth / TTY —
cf. `wrangler-d1-prod-route-to-user`). Two things: an S3 token (as Worker secrets) and a bucket
CORS policy.

### 5.1 R2 S3-API token → Worker secrets

Dashboard: **R2 → Manage R2 API Tokens → Create API Token**:
- **Permissions:** **Object Read & Write** (the least-privilege tier that allows PUT; R2 has no
  PUT-only granularity).
- **Scope:** **a single bucket — `deltos-blobs`** (not "all buckets").
- **TTL:** no expiry (or a long one) — it's a server secret.

It returns an **Access Key ID** + **Secret Access Key** (shown once). Put them in the Worker:

```bash
# run from packages/worker (standing Wrangler auth covers it)
wrangler secret put R2_ACCESS_KEY_ID        # paste the Access Key ID
wrangler secret put R2_SECRET_ACCESS_KEY    # paste the Secret Access Key
```

The S3 **endpoint host** is `https://<account_id>.r2.cloudflarestorage.com` where `<account_id>`
is the `account_id` already in `wrangler.jsonc` (`462b5ee1…`) — derive it in code (or add a
non-secret `R2_S3_ENDPOINT` var); **no new secret needed for the endpoint.** The bucket name
`deltos-blobs` is likewise already in `wrangler.jsonc`.

### 5.2 R2 bucket CORS (allow the browser PUT from the app origin)

A browser PUT direct to R2 is cross-origin (app is `deltos.blackgate.studio`, R2 is
`*.r2.cloudflarestorage.com`), so the bucket must allow it. **Dashboard (authoritative): R2 →
`deltos-blobs` → Settings → CORS Policy → Edit**, paste:

```json
[
  {
    "AllowedOrigins": ["https://deltos.blackgate.studio"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

- `AllowedOrigins` is the **single app origin** — not `*` (scope the write surface to deltos).
- `AllowedHeaders` must include **`x-amz-checksum-sha256`** (the signed integrity header) and
  `content-type`; the browser preflight (`OPTIONS`) checks these.
- `AllowedMethods` is **`PUT` only** (the direct path only ever PUTs; reads still go through the
  authed Worker GET).

CLI alternative (verify the exact subcommand first — `wrangler r2 bucket cors --help`):

```bash
wrangler r2 bucket cors put deltos-blobs --file cors.json   # confirm flag name via --help
```

> **Provisioning checklist for Jim:** ① create the **Object Read & Write**, **single-bucket
> (`deltos-blobs`)** R2 API token; ② `wrangler secret put R2_ACCESS_KEY_ID` /
> `R2_SECRET_ACCESS_KEY`; ③ set the bucket **CORS** policy above (PUT, app origin,
> `x-amz-checksum-sha256`). That's the whole external surface — no new binding, no schema.

---

## 6. Client routing + progress UI

### 6.1 The size router in `createFileNote`

`createFileNote(file)` (`db/mutate.ts` §5.1) gains a single branch at the top:

```ts
if (file.size <= DIRECT_R2_THRESHOLD) {
  ({ hash, size } = await uploadBlob(file));              // EXISTING buffered path, unchanged
} else {
  ({ hash, size } = await uploadBlobDirect(file, { onProgress, signal }));  // NEW direct path
}
// …mint the note from { hash, name: file.name, mime: file.type, size } — IDENTICAL below this line
```

Both branches yield `{ hash, size }`; **everything below the branch (note minting,
`putNoteAndEnqueue`, abort-on-failure-no-orphan) is unchanged.** Both helpers stay
dynamic-imported so `blobClient` and the direct-upload code stay **out of the entry bundle**
(perf north-star; `createFileNote` is reached only from the lazy desktop-drop chunk / a future
picker).

### 6.2 `uploadBlobDirect(file, { onProgress, signal })` (new in `blobClient.ts`)

1. **Hash the file** client-side: `crypto.subtle.digest('SHA-256', await file.arrayBuffer())` →
   hex. (A one-time read of the file into memory; acceptable for v1 — flag the mobile-memory
   cost of a multi-hundred-MB `arrayBuffer()` in §8, OQ-3.)
2. `POST /api/plugin/blob/presign { hash, size: file.size, mime }` (bearer-authed) → `{ url,
   headers }`.
3. **PUT via `XMLHttpRequest`** (not `fetch` — only XHR exposes **upload** progress in browsers):
   - `xhr.open('PUT', url)`, set each returned header, `xhr.send(file)`.
   - `xhr.upload.onprogress = e => onProgress(e.loaded / e.total)` — drives the progress bar.
   - **Cancel:** wire `signal` (an `AbortController`) to `xhr.abort()`; an abort rejects the
     promise → `createFileNote` aborts → **no note minted** (consistent with the existing
     abort-on-failure-no-orphan rule). A non-2xx PUT (incl. R2's checksum `400`) rejects too.
4. `POST /api/plugin/blob/confirm { hash, mime }` → `{ hash, size }`; return it.

The helper carries the bearer only on the **presign** and **confirm** calls (Worker routes); the
**PUT carries no bearer** — it's authorized by the presigned signature, not the session (correct:
R2 has no notion of the deltos session).

### 6.3 Progress + cancel UX

A 300 MB upload over cellular is minutes long and **must** show progress + a cancel control.

**Recommended (v1, simplest, consistent): upload-first with a standalone progress affordance; mint
the note only on success** — preserving the existing *no orphan note* invariant:
- An **upload-tracking store** (a small client store of in-flight uploads: `{ id, name, progress,
  cancel }`). `dropFilesOnList` (and the future mobile picker) registers each large upload there
  before awaiting it; `onProgress` updates it; on settle it's removed.
- A small **upload-progress UI** — a pinned card/toast region (e.g. bottom of the notes-list pane
  on desktop) rendering one row per in-flight upload: **filename · progress bar (%) · Cancel**.
  Cancel calls the stored `AbortController.abort()`.
- On success the new file-note pill appears via the existing reactive `observeNotes` query (the
  note is minted post-confirm), exactly as a small-file drop does today — **the creation flow looks
  identical to the user**, just with a progress bar while the big bytes move. Small-file drops keep
  their instant behavior (no progress UI needed; they complete in one buffered request).

**Alternative (nicer feel, more surface): mint the note first** in an "uploading" state so the pill
appears immediately with an inline progress overlay, finalizing on confirm / deleting the local note
on cancel. This introduces a pending-note state and the orphan-note cleanup the current design
avoids — **deferred** unless Jim wants the immediate-pill feel (§8 OQ-4).

The inline attachment path is **not** given progress UI (it stays ≤ 25 MB buffered, fast,
unchanged).

---

## 7. Security model (secSys pre-read)

The direct path moves the bytes out of the Worker; the model below is what keeps the buffered
path's audited properties intact by other means. **secSys must check each:**

- **Presigned-URL key-scoping (the BOLA control).** The Worker, **not the client**, fixes
  `key = {server-derived accountId}/{validated 64-hex hash}` and signs that exact key. Confirm:
  there is **no** code path where a client-supplied prefix, account, or arbitrary key reaches the
  signer; a caller can obtain a URL that writes **only** to its own one slot. (`hash` is regex-
  gated to `[0-9a-f]{64}` — no path traversal, no key steering.)
- **Short-enough / scoped TTL.** `X-Amz-Expires` is generous (1h) **only because** the URL is
  scoped to one key + one checksum, so a leaked URL can upload **only the identical pre-chosen
  bytes to the owner's own slot** — no cross-account write, no arbitrary content, no marginal
  risk. secSys confirms the scoping (not just the TTL number) is what makes this safe.
- **R2-checksum integrity (content-address still trustworthy).** The signed
  `x-amz-checksum-sha256` is bound into the URL from the **same** value as the key's hash;
  R2 rejects a non-matching body. secSys verifies the checksum is **derived server-side from the
  validated hash** (not echoed from a second client field) so key and checksum can't be decoupled,
  and that the build **observed** a real mismatch rejection (DR-INTEGRITY).
- **R2 token custody + least privilege.** `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are Worker
  **secrets** (never in client/bundle/repo); the token is **Object Read & Write on the single
  `deltos-blobs` bucket** (the least-privilege tier that permits PUT). secSys confirms the token
  scope and that the secret never crosses to the client.
- **CORS scope.** Bucket CORS allows **PUT** from the **single app origin** with the
  `x-amz-checksum-sha256` header — not `*` origin, not extra methods. secSys confirms the policy
  is the §5.2 shape.
- **Post-hoc quota + the orphan/abuse window.** Confirm enforces `ACCOUNT_BLOB_QUOTA` post-hoc and
  rolls back an over-quota object; the pre-confirm orphan window is acknowledged, mapped to the
  existing deferred orphan-GC class, and the >1-user hardening (staging-TTL or live GC) is flagged
  (§4, §8). secSys confirms the quota rollback exists and the orphan posture is the documented one.
- **Serving path UNCHANGED — these big files are NOT inline-served.** A blob stored via the direct
  path is read back through the **same** authenticated `GET /api/plugin/blob/:hash` — `octet-stream`
  + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + `default-src 'none';
  sandbox` CSP (`blob.ts` §3). **No inline route is added**; a 101 MB PDF is downloaded or fed to
  the in-app pdf.js reader (`pdf-reader.md`) from those octet-stream bytes — never served as active
  content on the app origin. secSys confirms `blob.ts`'s safe-serving boundary is untouched.

### secSys checklist (DR-S, blocking)

- **DR-S** — secSys-reviewed: ① key-scoping is server-fixed (`{accountId}/{hash}`, accountId from
  bearer, hash regex-gated) with no client key-steering path; ② the signed `x-amz-checksum-sha256`
  is derived server-side from the same hash (key+checksum inseparable) and R2 **observably** rejects
  a mismatch; ③ the presigned URL's generous TTL is safe *because* of the one-key/one-checksum
  scoping (no cross-account / arbitrary-content write even if leaked); ④ the R2 token is a Worker
  secret, Object-R/W, single-bucket, never client-exposed; ⑤ CORS is PUT + single app origin +
  the checksum header; ⑥ post-hoc quota rollback works and the orphan window is the documented,
  deferred-GC class (with the >1-user hardening flagged); ⑦ `blob.ts` serving is unchanged — these
  files are octet-stream/attachment/nosniff, never inline.

---

## 8. Build slices (independently shippable)

Lead with the Worker authorize/confirm + Jim's provisioning (the bytes can't move without it),
then the client routing + progress, then the secSys + live large-file proof. The **perf
north-star** holds throughout: the direct-upload code is a **lazy chunk** off `createFileNote`,
never in the entry bundle, never on the inline-attachment or first-paint path.

### Slice 1 — Worker presign + confirm + creds/CORS (the authorize/record spine)
The two endpoints on `routes/blob.ts`: `POST /presign` (validate → sign the scoped PUT with
`aws4fetch`, checksum-bound) and `POST /confirm` (HEAD → real size → post-hoc quota rollback →
`{hash,size}`). Wire the `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets + the S3 endpoint from
`account_id`. **Jim provisions** the R2 token + bucket CORS (§5). Tested against the **real
bucket** (presign + a real PUT + a deliberate **checksum-mismatch rejection**) — the integrity
control can't be unit-faked. **Gates:** DR-1, DR-2, DR-INTEGRITY, DR-QUOTA, DR-S (key-scoping).

### Slice 2 — Client size-routing + direct PUT + progress UI
`DIRECT_R2_THRESHOLD` + the `file.size` branch in `createFileNote`; `uploadBlobDirect` (hash →
presign → XHR PUT with progress → confirm) in `blobClient.ts`; the upload-tracking store + the
progress/cancel UI in the list pane; `dropFilesOnList` registers large uploads. Inline
`attachmentDrop` untouched (regression-checked). **Gates:** DR-3, DR-4, DR-5, DR-P.

### Slice 3 — secSys review + live large-file smoke
Full secSys pass (§7 / DR-S) + deploy to `deltos.blackgate.studio` and a **live smoke uploading
the real 101 MB PDF** end-to-end (drop → progress → confirm → the pill appears → open it in the
pdf reader → download). **Gates:** DR-S (full), DR-SMOKE.

> Slices 1 and 2 are each meaningful: after Slice 1 a `curl`/script can presign+PUT+confirm a
> large object against the real bucket (the mechanism proven headless); Slice 2 makes it a real
> drop-a-big-file UX. Slice 1 lands first (Slice 2's client calls its endpoints).

---

## 9. Acceptance gates (DR-*)

**Worker — authorize / record**
- **DR-1** — `POST /presign` requires auth (401 unauthenticated), validates `hash` is 64-hex
  (400 otherwise), rejects `size ≤ MAX_BLOB_SIZE` (small path) and `size > MAX_DIRECT_BLOB_SIZE`
  (413), and returns a presigned PUT URL whose key is **exactly `{server-accountId}/{hash}`** with
  a server-derived `x-amz-checksum-sha256` signed header. A second account presigning the *same*
  hash gets a URL under **its own** prefix (no cross-account key).
- **DR-2** — `POST /confirm` HEADs `{accountId}/{hash}`, returns `{ hash, size }` with the
  **R2-measured** size (404 if the object is absent — no note for a missing blob); the shape is
  byte-identical to `uploadBlob`'s response so `createFileNote` is path-agnostic.

**Integrity (the load-bearing control)**
- **DR-INTEGRITY** — Against the **real bucket**: a PUT whose body matches the signed checksum
  **succeeds** and lands at `{accountId}/{hash}`; a PUT whose body **does not** match
  `x-amz-checksum-sha256` is **rejected by R2** (no object stored). The content-address is
  enforced without the Worker ever reading the bytes. (Observed, not assumed.)

**Quota**
- **DR-QUOTA** — `confirm` enforces `ACCOUNT_BLOB_QUOTA` post-hoc: an upload that pushes the
  account over quota is **deleted** and returns 413; an in-quota upload is kept. A dedup re-upload
  of already-stored bytes is **not** rolled back (zero net usage).

**Client — routing / UX**
- **DR-3** — `createFileNote` routes by `file.size`: ≤ 25 MB → existing `uploadBlob` (buffered,
  unchanged, incl. the image WebP bake); > 25 MB → `uploadBlobDirect`. Below the upload call the
  note minting is identical for both. **Inline editor attachment (`attachmentDrop`) is unchanged
  and still capped at the buffered 25 MB** (no regression).
- **DR-4** — `uploadBlobDirect` hashes the file, presigns, PUTs **direct to R2 with upload-progress
  events** (XHR), and confirms; a successful large upload mints a file note whose body points at
  `{ hash, name, mime, size }` and which **opens, downloads, and syncs** exactly like a small file
  note (same `{accountId}/{hash}` key, same GET).
- **DR-5** — The progress UI shows filename + a live progress bar for an in-flight large upload and
  a **Cancel** that aborts the PUT → **no note is minted** (no orphan note). A failed/aborted upload
  surfaces a toast and leaves no note.

**Perf (north-star — blocking)**
- **DR-P** — `uploadBlobDirect` / `blobClient` / the progress UI are **lazy** — not in the entry
  bundle, not on the inline-attachment or first-paint path; reached only from `createFileNote`
  (desktop-drop chunk / future picker). Opening a notebook loads none of it. (Confirm via the
  chunk graph; mirrors `file-notes.md` FN-8.)

**Security (secSys — blocking)**
- **DR-S** — the §7 checklist: server-fixed key-scoping (no steering), server-derived inseparable
  checksum + observed R2 mismatch-rejection, scoped-TTL safety, Worker-secret + least-privilege +
  single-bucket R2 token, PUT/single-origin/checksum-header CORS, post-hoc quota rollback + the
  documented orphan posture, and **`blob.ts` serving unchanged** (octet-stream/attachment/nosniff —
  never inline).

**Live smoke**
- **DR-SMOKE** — Per `review-on-live-never-local-preview`: deploy to `deltos.blackgate.studio` and
  upload the **real 101 MB PDF** on-device end-to-end — drop → progress bar advances → confirm →
  the file-note pill appears → open it (pdf reader) → download yields the intact 101 MB file. No
  Worker memory/CPU error (the bytes never transit the Worker).

---

## 10. Open questions

1. **Orphan cleanup before >1 user (§4)** — v1 leans on the **already-deferred orphan-GC** (an
   unconfirmed direct upload is the same orphan class as a soft-deleted file note's blob). HARD
   before real users: either a **staging prefix + R2 lifecycle TTL + server-side copy on confirm**
   (automatic cleanup, costs a copy) or the **orphan-GC sweep made real**. Recommend the latter
   unless pre-confirm orphan abuse becomes real. Confirm the deferral is acceptable for the
   single-user phase.
2. **Single PUT vs multipart (§3.4)** — v1 = **single PUT**, `MAX_DIRECT_BLOB_SIZE = 2 GB`.
   Multipart (resumable, > 5 GB) is the documented upgrade when files routinely exceed a few hundred
   MB or resumability on flaky mobile becomes a felt need. Confirm single-PUT is fine for now.
3. **Client-side hashing memory (§6.2)** — `crypto.subtle.digest` needs the file in an
   `ArrayBuffer` (a ~Nx MB allocation); fine on desktop, heavier on mobile for a multi-hundred-MB
   file. crypto.subtle has no streaming digest. Accept for v1 (desktop-drop is the only entry until
   the mobile picker lands); revisit a chunked/WASM streaming hash if mobile uploads of very large
   files get janky.
4. **Note-first vs upload-first progress (§6.3)** — v1 = **upload-first** (no orphan note; pill
   appears on success). The immediate-pill "uploading" state is a nicer feel but adds a pending-note
   state + cleanup; deferred unless Jim wants it.
5. **Mobile large-file entry** — the direct path is wired into `createFileNote`, so the future
   mobile file-picker (`file-notes.md` §5.2) gets it for free once that picker exists. Out of this
   spec's first build (desktop-drop only), but the routing is picker-agnostic.
6. **Threshold tuning (§2.2)** — recommended **25 MB** (= `MAX_BLOB_SIZE`, no buffered-cap change).
   If Jim later wants the buffered path to absorb more (it's safe to ~90 MB), the threshold and
   `MAX_BLOB_SIZE` move together — but there's no reason to until a real need, since the direct path
   already covers everything above it.
