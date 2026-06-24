# Rich embeds — spec & roadmap (DESIGN IN PROGRESS)

Status: **Rungs 0–2 + `/api/unfurl` SHIPPED — v1 live 2026-06-24. Rung 3 (provider embeds) +
SSRF/throttle "before real users" gates remain OPEN (legitimately future — do not close these).** Owner:
navSys-2 (planner). This is the **first concrete content "shard"** and is intended to pull
the plugin/block-shard architecture (`[[slash-palette-block-shard-architecture]]`, task #62)
into existence. Builds on the in-flight link-click fix (links open in a new tab).

**🔑 LOCKED BOUNDARY (Jim, 2026-06-23): clickable URLs = CORE EDITOR; the fancy card/providers =
the EMBEDS PLUGIN.** Jim: "clickable URLs is an editor feature, and the fancy version lives in
the embeds plugin." So the ladder splits exactly at the editor/plugin line:
- **Core editor owns:** the link mark, click-to-open-in-new-tab (rung 0), and paste/type-autolink
  (rung 1). Plain clickable URLs are a baseline editor capability — no plugin needed.
- **The embeds plugin owns:** the rich link CARD (rung 2) and provider embeds (rung 3). This is
  the **first real plugin/shard** → building it stands up the #62 plugin-runtime as its host.
This is the same one-way-decoupled discipline as the Deck adapter: editor core stays plugin-
agnostic; the embeds plugin registers into it.

---

## 0. Jim's vision (verbatim intent, 2026-06-23)

> "Rich embeds — the first part in a bigger plugin. Start with the most basic (paste a valid
> URL and have it clickable) up to advanced YouTube / Spotify embeds. Rich website-of-any-URL
> embeds: a pasted URL turns into a clickable **card** — pull the site **favicon**, resolve the
> page **title**, **URL in small text** below. An **x in the corner** downgrades it back to a
> simple clickable URL. That's a good v1 for rich embeds."

So the feature is a **ladder** from plain-clickable-link → universal link card → provider-specific
rich embeds. The card (favicon + title + url-subtext + downgrade-x) is the explicit **v1 target**.

## 1. The ladder (rungs)

| Rung | What | Notes |
|---|---|---|
| **0** | Links open in a new tab on click | ✅ SHIPPED |
| **1** | Paste/type a bare URL → auto-linkify (clickable, no toolbar) | ✅ SHIPPED |
| **2** | Paste a URL → **rich LINK CARD** (favicon + resolved title + url-subtext), clickable, **x → downgrade to plain link** | ✅ SHIPPED — `/api/unfurl` worker endpoint + card node live |
| **3** | Provider embeds — YouTube / Spotify / etc. → interactive players (oEmbed / iframe) | OPEN — future. Provider registry; each provider = a card variant or its own renderer. |

## 2. The one hard technical reality — title/favicon needs the server

A browser **cannot** fetch an arbitrary cross-origin page to read its `<title>` / favicon / OG
tags (CORS blocks it). So "resolve the title + favicon of any URL" requires a **Worker endpoint
that fetches the URL server-side**, parses metadata, and returns it. Same shape as the voice
`/api/transcribe` route.

- **New Worker route — `/api/unfurl?url=…`** (name TBD): server-side `fetch(url)` → parse
  `og:title` / `<title>`, `og:image` / `og:description`, favicon (`<link rel=icon>` or
  `/favicon.ico`) → return `{ url, title, description, image, favicon, siteName }`.
- Authed via the existing bearer/session (same fail-closed guard as transcribe).
- **CACHE** results (Cloudflare KV, keyed by normalized URL, with a TTL) — avoid re-fetching the
  same URL on every render / device / open; cheap and fast.
- 🔒 **SECURITY — SSRF is the headline risk (secSys pre-build shaping, 2026-06-23).** A Worker
  that fetches user-supplied URLs is a classic SSRF vector. REQUIRED controls:
  - **Scheme allowlist:** http/https only — reject file:, data:, javascript:, gopher:, ftp:, etc.
  - **Host denylist with FULL encoding normalization (the most-missed bypass):** canonicalize the
    host before checking; reject RFC-1918 (10/8, 172.16/12, 192.168/16), 127/8, 169.254/16 (incl.
    cloud metadata 169.254.169.254), ::1, fc00::/7, `localhost` — catching ALL literal encodings:
    decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f…`), `0.0.0.0`, IPv6 `[::1]`,
    IPv4-mapped IPv6 (`::ffff:127.0.0.1`), trailing-dot / uppercase hosts. A canonical-only/regex
    check is trivially bypassed.
  - **DNS-rebinding / TOCTOU is hard on Workers** (cannot pin `fetch()` to a pre-resolved IP).
    Posture: `redirect:'manual'` + re-validate EVERY redirect hop's host before following (cap
    hops, never auto-follow); treat the standalone-Worker egress limit as **defense-in-depth, not
    the sole control** (a Service Binding / Tunnel would change it — don't bet the model on it);
    accept residual rebind-to-unintended-PUBLIC-host risk, mitigated by **never returning the raw
    body** + size/time caps. A DoH pre-resolve is best-effort and does NOT fully close TOCTOU — say
    so honestly, don't imply it does.
  - **Content-Type gate + caps:** check Content-Type BEFORE reading the body; only parse text/html;
    response **size cap** (a few hundred KB — we only need `<head>`) + **fetch timeout**; don't
    stream large binaries.
  - **Returned metadata is UNTRUSTED:** og:title/description/site_name are attacker-controlled →
    return as plain TEXT and the **client must render them as text, never HTML** (XSS vector).
    favicon/og:image URLs are untrusted too (validate scheme; the client must not auto-fetch them
    in a way that re-opens SSRF / leaks).
  - **Cost amplifier:** unfurl is an open-fetch-amplifier (same class as transcribe). KV-cache
    covers repeat-fetch, NOT unique-URL flooding → a **durable per-account throttle is DEFERRED
    pre-real-users but HARD-required before >1 user** (gate on the real-users flip,
    `[[pre-real-users-clean-state-bias]]`).
  - secSys pressure-tests the committed SHA before ship.

- 🔒 **CLIENT-side image fetch (secSys final glance, 2026-06-23) — SHIPPED single-user; 1 HARD gate
  deferred.** The card renders the favicon (and possibly og:image) via `<img src={url}>` → the
  user's BROWSER fetches an attacker-influenceable URL. SHIPPED with `referrerPolicy="no-referrer"`
  on the favicon img (kills the Referer leak — required-now, done). **DEFERRED, HARD before
  real/multi users:** host-validate the RETURNED favicon/og:image URLs server-side (apply the
  `ssrfGuard` private-host check inside `safeImageUrl`, dropping any that resolve to a
  private/internal host) — closes the client-side-SSRF / internal-network-probe vector (a crafted
  public page setting `<link rel=icon href="http://192.168.1.1/…">` weaponizes the user's browser).
  Or proxy images through the worker. Same posture as the throttles: proportionate now, mandatory
  at scale. (XSS check PASSED: title/url render as React text nodes, no `dangerouslySetInnerHTML`.)

## 3. Data model — the card is a shard node that persists + syncs

The card is a **block node in the doc** (a content shard), not just a decoration — it persists in
note content and syncs like everything else.

- A ProseMirror **node** (either a dedicated `link_card` node, or the existing `plugin_block`
  node parameterized with a `link-embed` plugin id — TBD with the team / #62 design). Stores:
  `{ url, title, favicon, image?, siteName?, fetchedAt }` — the **resolved metadata is cached IN
  the node** so the card renders instantly on reopen / offline / other devices without re-unfurling
  (the Worker call is a one-time enrich-on-create, refreshable later).
- Rendered via a **React NodeView** (the card UI: favicon + title + url-subtext + downgrade-x).
- **Downgrade (the x):** replaces the card node with a plain text + link mark (the URL as a
  clickable inline link) — rung-1 representation. Reversible-feeling (re-paste to re-card).
- Syncs as part of note content (no new sync entity — it's in the document). Holds
  `[[performance-is-a-standing-value]]`: the card renders from cached node data; no network on open.

## 4. Interaction flow (v1 = rung 2)

1. User pastes a URL (see OPEN DECISION 1 for *when* it cardifies).
2. The pasted URL becomes a card node in a **loading state** (favicon placeholder + the raw URL).
3. Client calls `/api/unfurl` → fills favicon + title + url-subtext. (Loading → resolved; on
   failure, fall back to a plain clickable link or a bare card with just the URL.)
4. Card is **clickable → opens the URL in a new tab** (consistent with the rung-0 link behavior).
5. **x in the corner → downgrade** to a plain clickable link.

## 5. Architecture — build it as the FIRST shard (proposed)

Jim framed this as "the first part in a **bigger plugin**." The bigger plugin = rich embeds;
the broader frame = the **block-shard / plugin architecture** (#62), where the `plugin_block`
node already exists in the schema. Proposal: build the link card as the **first real shard**, so
it instantiates the plugin-runtime / shard registry that provider embeds (rung 3) and the future
**attachment/file shard** then slot into as more shards. This is the forcing function for #62.
(See OPEN DECISION 2 — build-as-shard-now vs focused-feature-first.) Respects the Deck/extraction
and view-driven directions (`[[ui-view-driven-architecture]]`): a card is a *view* of a URL item.

## 5.1 GROUNDED ARCHITECTURE (scout 2026-06-23) — the plugin-runtime already exists in minimal form

A codebase recon confirmed the card needs **far less scaffolding than feared** — the seams exist:
- **`plugin_block` node is READY** (`editor/schema.ts:153-170`): an `atom` block with attrs
  `{ id, pluginType, pluginContent }`. `pluginContent` holds arbitrary opaque plugin metadata.
- **The registry IS the minimal plugin-runtime** (`editor/nodeviews/PluginIsland.ts`):
  `registerPluginIsland(type, factory)` + `buildPluginIslandNodeViews` dispatches a `plugin_block`
  to its registered factory by `pluginType`, falling back to `UnknownPluginIslandView`. So the
  embeds plugin = register a `link_card` factory; **no generic runtime to build first.**
- **Persistence is FREE — no migration** (`editor/serializer.ts:245-251, 396-402`): a block with an
  unknown `type` round-trips spine↔PM as a `plugin_block` carrying `pluginContent`. A `link_card`
  block stores `{ url, title, favicon, … }` in `pluginContent`, syncs on the existing spine, and
  **degrades gracefully** (renders the Unknown placeholder) if the plugin isn't registered. The
  spine `BlockType` is an open string — nothing to version.
- **NodeViews are IMPERATIVE** (no React helper; pattern = `editor/nodeviews/TodoItem.ts`): the card
  NodeView implements the PM `NodeView` interface directly (`dom`, `update`, `stopEvent:true` to
  trap inner clicks, `ignoreMutation:true`); to use React, mount a React root into `dom` manually.
- **Link reuse:** the link mark already renders `target=_blank rel=noopener` and `openLink.ts`'s
  `openLinkInNewTab()` is reusable for the card's click; **downgrade** = replace the card node with a
  paragraph of the URL text + a link mark (reuse `setLink()` in `commands.ts`).
- **Paste-to-card** = a plugin paste handler / the dynamic-reconfigure pattern spellcheck uses
  (`ProseMirrorEditor.tsx`); **rung-1 auto-linkify** = a small input rule in core `inputRules.ts`.
- **Module/boundary:** new `src/plugins/embeds/` (NodeView + registration + paste handler +
  unfurl-consume + downgrade + co-located `embeds.css`). Editor core never imports `src/plugins/`;
  the plugin registers via the one `registerPluginIsland()` seam (same one-way discipline as Deck).
- **Contention:** minimal — mostly NEW files; the only active touch-points are one registration
  call + a paste-handler wiring in `ProseMirrorEditor.tsx` and (for rung-1) `inputRules.ts`.

**Work split (plays to each hand's strength):**
- **E2a — LinkCard presentational component** (React + co-located CSS): props `{ url, title,
  favicon, siteName, loading, error }` + callbacks `onOpen` / `onDowngrade`. Standalone, testable,
  ZERO ProseMirror. → a gruntSys hand now (its Settings-UI strength).
- **E2b — the embeds plugin** (PM NodeView mounting E2a + `registerPluginIsland('link_card', …)` +
  paste-to-card handler + unfurl-consume + downgrade-to-link). → devSys-2 (PM specialist) after the
  voice mic-UI. Built against the unfurl contract (mockable; not blocked on gruntSys-2's endpoint).
- **E1 — rung-1 paste-autolink** (core-editor input rule) → small; with devSys-2's E2b cycle.

## 6. DECISIONS (locked with Jim 2026-06-23 unless marked)

1. ✅ **Editor vs plugin boundary** — clickable URLs (rungs 0-1) = core editor; card + providers
   (rungs 2-3) = the embeds plugin. (See LOCKED BOUNDARY at top.)
2. ✅ **Build the fancy version as the first SHARD/PLUGIN** — confirmed; the embeds plugin stands
   up the #62 plugin-runtime as its first occupant. No throwaway standalone.
3. ✅ **v1 = the universal link card** (rung 2); provider embeds (YouTube/Spotify players) = rung 3,
   later.
4. **When does a pasted URL become a CARD vs an inline link?** navSys-2 ASSUMPTION (proceeding
   unless Jim corrects): a URL **alone on its own line/block** → the embeds plugin upgrades it to a
   **card**; a URL pasted **inside a sentence** → stays a core-editor inline clickable **link**
   (the Notion / Slack pattern). Maps cleanly onto the editor/plugin split.
5. Card visual density / dimensions, and behavior on a failed unfurl (plain link vs bare card) —
   pin at build time, not blocking.

## 6.1 The real next-step = stand up the minimal plugin-runtime (#62)

Because rung 2 lives in the embeds plugin, the gating work for the card is **the plugin-runtime
itself** — the host seam the embeds plugin registers into (node(s) + NodeView + paste/transform
hook + the `plugin_block` schema node already present). This is the #62 design, now justified and
prioritized by a concrete first consumer. Spec that minimal runtime + the embeds plugin together
as the rung-2 arc. Rung 1 (paste-autolink) is a cheap **core-editor** interleave that needs none
of it and can land on top of the rung-0 link fix anytime.

## 7. Rough sequencing (once decisions lock)

Rung 1 (paste-autolink, small, client-only) can land immediately on top of the rung-0 fix while
the bigger pieces are specced. Rung 2 = the Worker unfurl route + SSRF gate (secSys) ‖ the card
node + NodeView + paste flow + downgrade ‖ caching. Rung 3 (providers) is additive on the shard.
Owners TBD (editor/Deck shard work = devSys-2; Worker unfurl route = devSys; secSys = SSRF gate).
