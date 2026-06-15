# S3 — iOS Multi-Webclip Storage Findings

**Spike:** Do same-origin iOS webclips share storage? Does in-scope nav stay standalone? What's
the quota model? Is one-storage-clip-per-notebook feasible?

**Note on evidence level:** No device probe was run this round — iPhone 15 Plus is on the
tailnet but can't be driven remotely. Findings below are marked **confirmed** (primary source:
WebKit docs, official Apple statements, Maximiliano Firtman's iOS-specific PWA testing) vs.
**best-evidence** (inferred, no contradicting source, but no explicit iOS test) vs. **unclear**
(ambiguous between sources, needs device test). Device-probe requirements are called out in §5.

---

## 1. Do same-origin webclips share storage?

**Answer: split — Cache Storage and SW registration are shared; IndexedDB (and all
script-writable storage) is isolated per webclip. OPFS is unknown.**

| Storage API | Shared across same-origin webclips? | Evidence |
|---|---|---|
| Service Worker registration | Yes, shared | confirmed |
| Cache Storage | Yes, shared | confirmed |
| IndexedDB | No, isolated per webclip | confirmed |
| localStorage / Web Storage | No, isolated per webclip | confirmed |
| Cookies | No, isolated per webclip | confirmed |
| OPFS | Unknown | unclear — needs device test |

**The confirmed model** (since iOS 14; fixed from the iOS 12.1 bug where all storage was
isolated per webclip including Cache/SW):

> Cache Storage and the Service Worker registration are shared across all same-origin webclips
> AND across browser Safari tabs for that origin. IndexedDB, localStorage, and cookies are
> siloed — each home-screen icon gets its own independent context.

Source: Firtman firt.dev/ios-14 — the canonical document. Apple's own February 2024 statement
(during the brief EU iOS 17.4 PWA disruption) confirmed the isolation as a deliberate security
property: "without storage isolation and enforcement, malicious web apps could read data from
other web apps." That statement makes clear IndexedDB isolation is intentional and treated as a
user safety feature, not a bug.

**OPFS (blob store concern):** OPFS was added to iOS Safari 16. The spec defines it as
per-origin, but iOS doesn't respect the per-origin spec for IndexedDB (it over-isolates to
per-webclip). Whether OPFS is isolated per-webclip or shared is undocumented in any primary
source (WebKit blog, Firtman, WebKit Bugzilla). Given that it's newer than the iOS 14 split,
either outcome is plausible. **Flag: this is the single most important open question for
deltos's blob store design.** See §5.

---

## 2. Does in-scope navigation stay in standalone mode?

**Answer: yes, confirmed. In-scope URLs stay fully standalone with no browser chrome. Out-of-
scope opens an in-app overlay, not a full browser tab.**

**In-scope navigation** (any URL within manifest `scope`):
- Stays inside the standalone window
- No address bar, no tab bar, no Safari chrome
- Back gestures work for in-scope history
- Client-side routes (hash, History API, RSC/Vite router) all stay standalone

**Out-of-scope navigation** (link to URL outside `scope`):
- Since iOS 12.2: opens an in-app browser overlay (SFSafariViewController-style) on top of the
  standalone window — has a "Done" button, no URL editing, shares storage context with the opener
- NOT a full Safari tab switch — the user returns to the standalone app when they dismiss
- If the overlay navigates back in-scope (e.g. OAuth callback), iOS closes the overlay and
  loads the URL in the standalone window — OAuth/OIDC flows work correctly

**Critical:** `scope` must be declared in the manifest. Omitting it causes iOS to treat every
link as out-of-scope and open it in a browser. For the multi-icon model, each webclip needs
`start_url` within the declared `scope` — a single `scope: "/"` covers all routes, keeping
all in-app navigation in standalone mode regardless of which icon was tapped.

---

## 3. Quota model

### Per-origin, not per-webclip

**Confirmed.** As of Safari 17 / iOS 17, WebKit uses a disk-percentage model:
- **Per-origin:** up to 60% of total disk space
- **All origins combined:** up to 80% of total disk space
- Cross-origin iframes: 10% of main-frame origin quota

Multiple same-origin webclips share one origin quota bucket. Adding more webclip icons does not
divide the quota — it stays at 60% of disk for the whole origin.

Practical ceiling: on a 256 GB iPhone, that's ~150 GB per origin. On a 64 GB device, ~38 GB.
Earlier iOS versions had a ~50 MB Cache Storage soft limit with a user-prompt gate for more;
that system was removed in Safari 17. `navigator.storage.estimate()` on iOS 17+ now returns
realistic per-origin estimates (not artificially capped numbers).

### 7-day ITP eviction exemption

**Confirmed.** WebKit's Intelligent Tracking Prevention (ITP) documentation
(`webkit.org/tracking-prevention`) states explicitly:

> "The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all
> script-writable storage, i.e. ITP always skips that domain in its website data removal algorithm."

This exemption is **per-domain** (i.e., per-origin) — installing any webclip from `deltos.app`
exempts the entire origin from ITP's 7-day deletion. Multiple webclips from the same origin don't
each need to be installed; one installed webclip protects the whole origin including the shared
Cache Storage.

**Caveat:** `StorageManager.persist()` (the Persistent Storage API) is listed as "supported" on
iOS 17+ but the grant is heuristic and not guaranteed. Don't rely on it. The ITP exemption is
more reliable than `persist()` for installed webclips. Storage can still be evicted under system
storage pressure (device nearly full), but that's outside ITP's purview.

---

## 4. One-storage-clip-per-notebook — recommendation

**Recommendation: PURSUE the one-clip-per-notebook model, with the OPFS decision deferred
until §5 is answered on-device.**

### What you get for free

IndexedDB isolation per webclip is confirmed and intentional. For deltos's purposes:

- Each notebook webclip has its own IndexedDB silo — note data, property bags, sync queue,
  version counters are all isolated at the iOS level, no application-level namespace needed
- A note created offline in the Recipes webclip is not accessible from the TTRPG webclip's
  IndexedDB until both sync to the server — which is exactly the online-first "each icon is an
  independent client converging through the cloud" model from brainstorm.md
- No cross-notebook data leakage at the client without going through the server

The shared Service Worker / Cache Storage is a win for the **app-shell precache** (one copy of
static assets serves all webclip icons; SW version transitions are seamless across notebooks),
**but it carries a hard isolation constraint:** because Cache Storage is shared while IndexedDB
is per-clip isolated, the per-notebook silo is a confidentiality boundary only if notebook
content never enters Cache Storage — the SW must **never** runtime-cache `/api/*` responses
(note bodies, search results, properties) into Cache Storage. Only origin-global app-shell
assets belong there. Violating this would let one webclip's SW read another notebook's cached
plaintext responses. The shipped sw.ts is correct on this today; this is a forward constraint
against any future runtime-caching of API routes.

### The acceptable tradeoffs

**Offline universal search** becomes "search within this notebook only" when offline. Online-first
makes this acceptable — the common case is the server handles cross-notebook search. Brainstorm.md
already calls this out: "both run online in the common case."

**Cross-notebook transport** offline: if a user creates a note in the Recipes clip and wants to
move it to TTRPG while offline, they can't — the TTRPG clip's IndexedDB is a separate silo.
Transport goes through the server. Same conclusion: acceptable for an online-first design.

**SW update coordination:** A single Service Worker handles all webclip clients. A SW update
activated from one webclip closes other clients' old versions on next navigate — if the user has
two webclips open simultaneously, an activation in one will refresh the other. This is standard
PWA behavior but worth noting as a potential UX surprise.

### The OPFS dependency

Deltos plans to use OPFS for blob/media storage ("better than IndexedDB for big blobs"). If OPFS
is **isolated per webclip** (same as IndexedDB), the one-clip-per-notebook model gives you clean
blob isolation with no extra work — each notebook's media files live in its own OPFS context.

If OPFS is **shared across webclips** (same as Cache Storage), blobs from all notebooks would
share one OPFS space. This isn't a showstopper — the blob store already uses content-addressed
IDs (`hash(content)`) so there are no key collisions, and sharing blobs between notebooks
actually gives free dedup (a photo in Recipes and in Journal would be one blob). The application
layer would need to manage which notebooks can see which blobs (a metadata layer in IndexedDB
scoped per webclip, pointing at shared OPFS blobs) — more complex but workable.

**The recommendation doesn't change either way**, but the blob store design does. Defer the blob
architecture decision until OPFS behavior is confirmed on-device (see §5).

---

## 5. Open questions — flag for device probe

The iPhone 15 Plus is on the tailnet at `iphone-15-plus` (100.114.109.90). A probe page served
from `$DEVBOX_URL` over HTTPS (Tailscale serve) is directly reachable. The probe is throwaway —
a single HTML page that can be manually opened and added to the home screen.

### Probe 1 — OPFS isolation (HIGHEST PRIORITY)

Build a single probe page. Add it to home screen twice at two different routes (e.g.
`https://devbox.tail41404c.ts.net:8449/probe?clip=A` and `/probe?clip=B`). Each clip:
1. On open, reads a key from OPFS (`/probe-key.txt`)
2. Writes its clip ID + timestamp to OPFS (`/probe-key.txt`)
3. Shows whether the read returned the OTHER clip's write or came up empty

If Clip A's write is visible to Clip B → OPFS is shared. If not → isolated.

Expected probe code: ~40 lines of vanilla JS, served statically, not kept in the tree.

### Probe 2 — IndexedDB isolation (confirm the documented behavior)

Same two-clip setup. Each clip writes a keyed value to IndexedDB, reads the other key. Should
confirm isolation (Firtman-documented) — worth a quick check since you're already doing the OPFS
probe.

### Questions the probe answers

| Question | Why it matters |
|---|---|
| Is OPFS isolated per webclip? | Determines blob store architecture |
| Does IndexedDB isolation hold on latest iOS? | Confirms the design assumption |
| Any SW cache serving quirks with two clips? | Sanity-check the shared SW |

---

## 6. Summary

| Question | Answer | Evidence |
|---|---|---|
| Same-origin webclips share IndexedDB? | No, isolated per webclip | confirmed |
| Same-origin webclips share Cache Storage? | Yes, shared | confirmed |
| Same-origin webclips share OPFS? | Unknown | unclear — device probe needed |
| In-scope navigation stays standalone? | Yes | confirmed |
| Out-of-scope navigation opens full Safari tab? | No — in-app overlay | confirmed |
| Quota model | Per-origin, ~60% of disk | confirmed |
| 7-day ITP eviction exemption | Yes, per-origin, one install protects all clips | confirmed |
| One-clip-per-notebook: pursue? | Yes — pursue; defer blob architecture until OPFS confirmed | — |
