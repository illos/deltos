# Sub-spec — UI Tokens, Fonts & themeStore (Lane 0, turnkey)

**Status:** SHIPPED — v1 live 2026-06-24. Historical sub-spec for **Lane 0** of the
UI visual refresh (`docs/specs/ui-visual-refresh.md` §3). It carries the **exact** values from the
hi-fi packet (`docs/design/ui-refresh/README.md`) so the developer can implement without
re-deriving anything from the packet.

**Honored decisions (from the scoping spec §4):**

- **#5 — Default = `Ember × Sans × system`.** This *overrides* the packet's Graphite default.
  The theme root boots `palette=ember`, `voice=sans`, `mode=system`.
- **#4 — Everyday fast load > first-ever load; active fonts permanently cached on device.**
  Self-host subset woff2, `font-display: swap`. Default voice (IBM Plex Sans) + IBM Plex Mono
  (mandatory metadata) precached at SW install; the other 3 voices fetched once on first selection
  then cached forever.

**Reminder (load-feel gate):** report bundle delta on hand-back. No new heavy deps — this is plain
CSS custom properties + self-hosted woff2 + one tiny Zustand store. Token CSS lands in **both**
`styles.css` **and** the critical inline CSS in `index.html` (the duplication caution in the scoping
spec §2).

---

## 1. Theme-token CSS (ready to paste)

### 1.1 Selector strategy (read this first)

Three axes are applied as data-attributes on one theme root (`<html>` or `<body>`):
`data-palette` (`bone|graphite|manila|ember`), `data-mode` (`light|dark|system`),
`data-voice` (`serif|sans|mono|grotesk`).

**Colors** depend on `palette × resolvedMode`. The hard part is `mode=system`, which must resolve
to the OS preference at runtime. The DRY strategy that avoids a 4×3 explosion:

- Write each palette's **light** and **dark** token block **once**, behind a selector that fires for
  BOTH the explicit mode AND the matching system mode. We do this with a grouped selector:
  - light block: `[data-palette="X"][data-mode="light"], [data-palette="X"][data-mode="system"]`
    inside the *default* (light) context;
  - dark block: `[data-palette="X"][data-mode="dark"]` **plus** an
    `@media (prefers-color-scheme: dark)` override that re-points `[data-mode="system"]` to dark.
- So the matrix is: each palette has exactly **2** token blocks (light, dark) authored once, and the
  `@media (prefers-color-scheme: dark)` block contains **4** thin overrides (one `system` selector per
  palette) flipping system to the dark values. Total = 8 palette blocks + 4 system-dark overrides, no
  per-combination duplication, all three `mode` values supported cleanly.

**Voices** depend only on `data-voice` — a flat set of 4 blocks, independent of palette/mode.

> Implementation note: the system-dark override blocks repeat the dark hex of each palette. To keep
> ONE source of truth you may instead author dark tokens as a named custom-property group and re-assign,
> but plain CSS has no variable indirection across `@media` cleanly without `@property`/JS; the
> 4-block repeat below is the pragmatic, audit-friendly form. If you prefer zero hex repetition, drive
> `data-mode` to a *resolved* `light|dark` in JS (themeStore already computes the resolved mode for the
> `theme-color` meta — see §3) and drop the `system` selectors + `@media` entirely. **Both are valid;
> the CSS below supports `system` natively so the app works even before JS hydrates.**

### 1.2 Defaults on the root

```css
/* DEFAULT = Ember × Sans × system (decision #5). These attrs are also written by themeStore on init;
   declaring them here means the very first paint (pre-hydration) is already the correct default. */
:root {
  /* Fallback voice vars so text renders before [data-voice] is applied. Mirrors Sans (default). */
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; /* metadata — invariant */
  --ff: 'IBM Plex Sans', system-ui, sans-serif;
  --h1: 33px; --h1w: 700;
  --h2: 19px;
  --note: 16.5px; --line: 1.62;
  --lt: 14.5px; --ltw: 600;
  --nav-item: 14.5px; --nav-itemw: 500;
  --quote: 16.5px;
  --list-note: 14.5px;
}

/* Apply default axes if markup didn't (defensive; themeStore sets these for real). */
html:not([data-palette]) { /* treat as */ }
```

> In `index.html` set the attributes statically on the root element so the first paint matches the
> default with no FOUC: `<html data-palette="ember" data-voice="sans" data-mode="system">`. themeStore
> then overwrites them from IDB on init (§3).

### 1.3 Color tokens — all 4 palettes × {light, dark}

Hex copied **verbatim** from `docs/design/ui-refresh/README.md` §Color tokens (exact).

```css
/* ============================================================================
   COLOR TOKENS
   Strategy: each palette authored ONCE for light, ONCE for dark.
   - light selector matches data-mode=light AND data-mode=system (default light context)
   - explicit dark selector matches data-mode=dark
   - the @media(prefers-color-scheme: dark) block re-points data-mode=system → dark hex
   ========================================================================== */

/* ---------- BONE ---------- */
[data-palette="bone"][data-mode="light"],
[data-palette="bone"][data-mode="system"] {
  --paper:#FAF7F0; --list:#F3EEE4; --nav:#EAE4D8; --border:#E0D8C8;
  --ink:#25201A; --body:#3A332A; --secondary:#8A8170; --faint:#A0967F;
  --sel:#EBE1CF; --accent:#A8662F; --handle:#D8CFBD; --sync:#7FA86B;
}
[data-palette="bone"][data-mode="dark"] {
  --paper:#26211A; --list:#221E18; --nav:#1C1813; --border:#332E25;
  --ink:#EDE6D8; --body:#D8D0C0; --secondary:#9C9484; --faint:#857C6A;
  --sel:#2E281F; --accent:#C98A4A; --handle:#3A3429; --sync:#8FBE78;
}

/* ---------- GRAPHITE ---------- */
[data-palette="graphite"][data-mode="light"],
[data-palette="graphite"][data-mode="system"] {
  --paper:#FFFFFF; --list:#F7F8FA; --nav:#F0F1F3; --border:#E5E7EB;
  --ink:#1A1C1F; --body:#33373D; --secondary:#6B7177; --faint:#8A9099;
  --sel:#E7EBF3; --accent:#3B5BDB; --handle:#D2D6DC; --sync:#3BA776;
}
[data-palette="graphite"][data-mode="dark"] {
  --paper:#202225; --list:#1B1D1F; --nav:#161719; --border:#2C2F33;
  --ink:#E6E8EB; --body:#C4C8CD; --secondary:#8B9197; --faint:#777E85;
  --sel:#23304D; --accent:#5B7BFF; --handle:#34383D; --sync:#42C28C;
}

/* ---------- MANILA ---------- */
[data-palette="manila"][data-mode="light"],
[data-palette="manila"][data-mode="system"] {
  --paper:#F8F7F0; --list:#F2F0E7; --nav:#E8E6DD; --border:#DFDACE;
  --ink:#2B2722; --body:#423C33; --secondary:#877F70; --faint:#A89F8C;
  --sel:#EAE0CF; --accent:#9E3B2E; --handle:#D5CFC0; --sync:#7B9A66;
}
[data-palette="manila"][data-mode="dark"] {
  --paper:#25221B; --list:#201E18; --nav:#1A1813; --border:#322D24;
  --ink:#E8E2D4; --body:#CBC3B3; --secondary:#968D7C; --faint:#857C6A;
  --sel:#2D281F; --accent:#C75A48; --handle:#3A3429; --sync:#8FAE74;
}

/* ---------- EMBER (default palette) ---------- */
[data-palette="ember"][data-mode="light"],
[data-palette="ember"][data-mode="system"] {
  --paper:#FFFFFF; --list:#F7F7F8; --nav:#F2F2F4; --border:#E7E7EB;
  --ink:#17171A; --body:#36363B; --secondary:#6E6E76; --faint:#A0A0A8;
  --sel:#FBEAE4; --accent:#EE431C; --handle:#D6D6DA; --sync:#1FA971;
}
[data-palette="ember"][data-mode="dark"] {
  --paper:#1A1A1D; --list:#161618; --nav:#111113; --border:#2A2A2E;
  --ink:#F0F0F2; --body:#C8C8CE; --secondary:#9A9AA3; --faint:#6E6E77;
  --sel:#2E211D; --accent:#FF6242; --handle:#34343A; --sync:#34C98A;
}

/* ---------- SYSTEM → DARK re-point ----------
   When the OS prefers dark, data-mode="system" adopts each palette's DARK hex.
   (Explicit data-mode="light"/"dark" are unaffected — user override wins.) */
@media (prefers-color-scheme: dark) {
  [data-palette="bone"][data-mode="system"] {
    --paper:#26211A; --list:#221E18; --nav:#1C1813; --border:#332E25;
    --ink:#EDE6D8; --body:#D8D0C0; --secondary:#9C9484; --faint:#857C6A;
    --sel:#2E281F; --accent:#C98A4A; --handle:#3A3429; --sync:#8FBE78;
  }
  [data-palette="graphite"][data-mode="system"] {
    --paper:#202225; --list:#1B1D1F; --nav:#161719; --border:#2C2F33;
    --ink:#E6E8EB; --body:#C4C8CD; --secondary:#8B9197; --faint:#777E85;
    --sel:#23304D; --accent:#5B7BFF; --handle:#34383D; --sync:#42C28C;
  }
  [data-palette="manila"][data-mode="system"] {
    --paper:#25221B; --list:#201E18; --nav:#1A1813; --border:#322D24;
    --ink:#E8E2D4; --body:#CBC3B3; --secondary:#968D7C; --faint:#857C6A;
    --sel:#2D281F; --accent:#C75A48; --handle:#3A3429; --sync:#8FAE74;
  }
  [data-palette="ember"][data-mode="system"] {
    --paper:#1A1A1D; --list:#161618; --nav:#111113; --border:#2A2A2E;
    --ink:#F0F0F2; --body:#C8C8CE; --secondary:#9A9AA3; --faint:#6E6E77;
    --sel:#2E211D; --accent:#FF6242; --handle:#34343A; --sync:#34C98A;
  }
}
```

### 1.4 Type voices — type-scale vars

Values copied **verbatim** from `README.md` §Typography per-voice table.

```css
/* ============================================================================
   TYPE VOICES (independent of palette/mode)
   var map: --ff body/UI font · --h1/--h1w note title · --h2 heading
            --note/--line body copy · --lt/--ltw list-row title
            --nav-item/--nav-itemw nav item · --quote · --list-note
   Derived (packet §Typography): h3 = calc(var(--h2)*0.84) wt 600;
                                 note-title letter-spacing = -0.015em.
   --quote / --list-note mirror --note unless the packet specifies otherwise.
   ========================================================================== */

[data-voice="serif"] {
  --ff: 'Newsreader', Georgia, serif;
  --h1: 36px; --h1w: 600;
  --h2: 21px;
  --note: 17.5px; --line: 1.65;
  --lt: 15px; --ltw: 600;
  --nav-item: 15px; --nav-itemw: 400;
  --quote: 17.5px;
  --list-note: 15px;
}

[data-voice="sans"] {            /* DEFAULT VOICE */
  --ff: 'IBM Plex Sans', system-ui, sans-serif;
  --h1: 33px; --h1w: 700;
  --h2: 19px;
  --note: 16.5px; --line: 1.62;
  --lt: 14.5px; --ltw: 600;
  --nav-item: 14.5px; --nav-itemw: 500;
  --quote: 16.5px;
  --list-note: 14.5px;
}

[data-voice="mono"] {
  --ff: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --h1: 27px; --h1w: 600;
  --h2: 17px;
  --note: 15px; --line: 1.75;
  --lt: 13.5px; --ltw: 600;
  --nav-item: 13.5px; --nav-itemw: 400;
  --quote: 15px;
  --list-note: 13.5px;
}

[data-voice="grotesk"] {
  --ff: 'Space Grotesk', system-ui, sans-serif;
  --h1: 32px; --h1w: 600;
  --h2: 19px;
  --note: 16px; --line: 1.58;
  --lt: 14.5px; --ltw: 500;
  --nav-item: 14.5px; --nav-itemw: 500;
  --quote: 16px;
  --list-note: 14.5px;
}

/* Derived heading rules (apply wherever the editor / list render these nodes). */
.dt-h2, h2[data-editor] { font-size: var(--h2); font-weight: 600; color: var(--ink); }
.dt-h3, h3[data-editor] { font-size: calc(var(--h2) * 0.84); font-weight: 600; color: var(--ink); }
.dt-note-title, h1[data-editor] {
  font-family: var(--ff);
  font-size: var(--h1);
  font-weight: var(--h1w);
  color: var(--ink);
  line-height: 1.15;
  letter-spacing: -0.015em;   /* note-title negative tracking */
}
```

### 1.5 Cross-theme invariants (explicit CSS)

```css
/* ============================================================================
   INVARIANTS — never vary by palette/mode/voice (packet §The Theme System).
   ========================================================================== */

/* (a) Metadata is ALWAYS IBM Plex Mono — dates, counts, section labels (NOTEBOOKS),
       the "deltos" wordmark text, sync-status text. Small; labels uppercase + ~1.5px tracking. */
.dt-meta {
  font-family: var(--mono);
  font-size: 11px;            /* metadata range 10–11px */
  color: var(--secondary);
}
.dt-meta--faint { color: var(--faint); }
.dt-label {                   /* section labels e.g. NOTEBOOKS */
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--faint);
}

/* (b) Synced dot is ALWAYS green (--sync), NEVER the accent. "Saved" must not read as "alert". */
.dt-sync-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--sync);
}

/* (c) The δ wordmark GLYPH is ALWAYS Newsreader serif in the accent color,
       regardless of the chosen type voice. (The "deltos" text beside it is Plex Mono — invariant a.) */
.dt-wordmark-delta {
  font-family: 'Newsreader', Georgia, serif;
  color: var(--accent);
  font-weight: 600;
  /* size is contextual: 24px in nav wordmark; the brand glyph keeps serif+accent everywhere. */
}

/* (d) Highlight mark: accent-tinted background, text stays inherit. */
mark, .dt-mark {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  color: inherit;
}
```

> The `δ` character is `U+03B4`. Because `.dt-wordmark-delta` hard-pins Newsreader, the **Newsreader
> 600** glyph for `δ` must be available even when the active voice is not Serif. Two options: (1) keep
> Newsreader 600 in the always-loaded set (adds one small file — see §2), or (2) accept the system
> serif fallback for the single glyph until Newsreader loads. Recommended: include the single Newsreader
> weight needed for the wordmark in the precache set so the brand glyph is always correct (cheap; it's
> one weight, and the subset can be the Latin + Greek-δ range only).

---

## 2. Font self-hosting + permanent-cache plan (decision #4)

### 2.1 Families & weights to obtain (packet §Typography)

| Family | Weights | Extra axes / styles | Role |
|---|---|---|---|
| **IBM Plex Sans** | 400; 500; 600; 700 | — | DEFAULT voice (Sans) → **precache** |
| **IBM Plex Mono** | 400; 500; 600 | — | metadata (ALWAYS needed, every theme) → **precache** |
| **Newsreader** | 400; 500; 600 | `opsz 16..72`, `ital 0/1` | Serif voice → lazy; **+ δ-glyph subset always** (wordmark, §1.5) |
| **Space Grotesk** | 400; 500; 600; 700 | — | Grotesk voice → lazy |

> All four are Google Fonts originals. **Self-host subset woff2** rather than linking Google's CDN:
> - **Reliable permanent caching** — we control cache headers + the SW; Google's CSS/font URLs rotate
>   and can't be precached deterministically.
> - **Offline-capable** — this is an offline-first PWA; a third-party request breaks offline load.
> - **Same-origin** — no extra DNS/TLS/connection to fonts.gstatic.com on the critical path
>   (load-feel), and no render-blocking external CSS.
> - **Privacy** — no per-load beacon to a third party.
>
> Subset to the Latin range the app needs (basic Latin + Latin-1 + punctuation/quotes; add the Greek
> `δ` codepoint to the Newsreader wordmark subset). Tools: `glyphhanger` / `subfont` / `fonttools`
> `pyftsubset`. Convert to woff2 (already the smallest; only ship woff2 — every target browser supports it).

### 2.2 Path convention

```
packages/client/public/fonts/
  ibm-plex-sans-400.woff2   ibm-plex-sans-500.woff2
  ibm-plex-sans-600.woff2   ibm-plex-sans-700.woff2
  ibm-plex-mono-400.woff2   ibm-plex-mono-500.woff2   ibm-plex-mono-600.woff2
  newsreader-delta.woff2          # δ-glyph subset for the wordmark (always)
  # lazy (one CSS chunk each, fetched on first selection):
  newsreader-400.woff2 newsreader-500.woff2 newsreader-600.woff2
  newsreader-400-italic.woff2 ...                      # ital axis if used
  space-grotesk-400.woff2 ... space-grotesk-700.woff2
```

Files in `public/` are served at the site root (`/fonts/...`) and are **not** content-hashed by Vite
by default — see §2.5 for the deliberate revisioning so the SW treats them as permanent-until-changed.

### 2.3 `@font-face` for the DEFAULT-precached fonts

Put these in the **always-loaded** stylesheet (the main CSS, also reflected in the critical inline CSS
so first paint has the default voice). `font-display: swap` = text shows immediately in the fallback,
swaps when the woff2 arrives.

```css
/* ---- IBM Plex Sans (default voice) ---- */
@font-face {
  font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 400;
  font-display: swap; src: url('/fonts/ibm-plex-sans-400.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 500;
  font-display: swap; src: url('/fonts/ibm-plex-sans-500.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 600;
  font-display: swap; src: url('/fonts/ibm-plex-sans-600.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 700;
  font-display: swap; src: url('/fonts/ibm-plex-sans-700.woff2') format('woff2');
}

/* ---- IBM Plex Mono (metadata — ALWAYS) ---- */
@font-face {
  font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 400;
  font-display: swap; src: url('/fonts/ibm-plex-mono-400.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 500;
  font-display: swap; src: url('/fonts/ibm-plex-mono-500.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 600;
  font-display: swap; src: url('/fonts/ibm-plex-mono-600.woff2') format('woff2');
}

/* ---- Newsreader δ-glyph subset (wordmark invariant — ALWAYS) ---- */
@font-face {
  font-family: 'Newsreader'; font-style: normal; font-weight: 600;
  font-display: swap;
  src: url('/fonts/newsreader-delta.woff2') format('woff2');
  unicode-range: U+03B4;   /* only the δ — full Newsreader loads lazily with the Serif voice */
}
```

> Optional but recommended for the critical path: preload the two everyday files in `index.html`
> `<head>`:
> ```html
> <link rel="preload" href="/fonts/ibm-plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>
> <link rel="preload" href="/fonts/ibm-plex-mono-400.woff2" as="font" type="font/woff2" crossorigin>
> ```
> (`crossorigin` is required for font preloads even same-origin.) Preload only the 400 weights to keep
> the critical bytes minimal; the rest are pulled as text using them appears.

### 2.4 Lazy voices — load on selection, then persist

The 3 non-default voices (Serif/Newsreader full, Mono, Grotesk) are fetched **only when first chosen**,
then live in the SW cache forever (§2.5). Mechanism:

- Author **one CSS chunk per lazy voice** containing just that family's `@font-face` blocks, e.g.
  `src/styles/fonts/newsreader.css`, `space-grotesk.css`. (IBM Plex Mono is already precached for
  metadata, so the **Mono voice** needs no extra fetch — selecting it just sets `data-voice="mono"`;
  it reuses the always-loaded Plex Mono faces.)
- In `themeStore.setVoice(voice)`, before/while applying `data-voice`, **dynamically import** the
  matching chunk the first time that voice is selected:
  ```ts
  const FONT_CHUNK: Record<Voice, (() => Promise<unknown>) | null> = {
    sans: null,           // precached
    mono: null,           // reuses precached Plex Mono
    serif:   () => import('../styles/fonts/newsreader.css'),
    grotesk: () => import('../styles/fonts/space-grotesk.css'),
  };
  // call FONT_CHUNK[voice]?.() once; idempotent (the module is cached by the bundler after first import)
  ```
  Vite emits each as its own CSS asset; the dynamic `import()` injects a `<link>`/`<style>` only when
  reached. `font-display: swap` means the new voice paints immediately in fallback then swaps in.
- **Persistence:** once any voice's woff2 is fetched, the SW runtime-caching rule (§2.5) stores it
  cache-first with no expiry → every later load (this voice or app cold-start) serves from cache, zero
  network. So a voice is a one-time download, instant forever after.

### 2.5 Service-worker caching (vite-plugin-pwa / workbox) — make fonts permanent

The project already uses `vite-plugin-pwa` (workbox). Configure two things in `vite.config` →
`VitePWA({ workbox: { ... } })`:

```ts
VitePWA({
  // ...existing...
  workbox: {
    // (1) PRECACHE the everyday fonts at SW install so the first everyday load is instant + offline.
    //     Globbing public/ assets includes them; ensure the patterns/dir cover /fonts.
    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
    // (2) RUNTIME cache-first, NO expiration for the lazy voice fonts (and any font not precached),
    //     so they persist permanently on device once fetched, across deploys.
    runtimeCaching: [
      {
        urlPattern: ({ url }) => url.pathname.startsWith('/fonts/'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'deltos-fonts',
          // NO expiration plugin → entries never auto-evicted by age/count.
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  },
})
```

- **Precache (the 2 defaults + δ-subset):** workbox stamps each precached file with a **revision** in
  the generated manifest. The file is re-fetched **only if its content (revision) changes** on a new
  deploy; an unchanged font file is served from the precache forever. So Plex Sans + Plex Mono are
  install-time, offline-ready, and persist across deploys until the file itself changes.
- **Runtime CacheFirst, no expiry (the lazy voices):** first request for e.g.
  `/fonts/space-grotesk-500.woff2` goes to network, is stored in `deltos-fonts`, and **all** later
  requests serve from cache with no network. No `ExpirationPlugin` ⇒ no age/count eviction ⇒ permanent
  (subject only to the browser reclaiming storage under pressure, which is unavoidable for any cache).
- **Revisioning the lazy files (important):** `public/fonts/*` are **not** content-hashed by Vite, and
  the runtime rule is cache-first by URL — so if you ever change a lazy font file's *contents* but keep
  the *same* filename, cached clients keep the stale bytes. Mitigation: **version lazy font filenames**
  (e.g. `space-grotesk-500.v1.woff2`) and bump the suffix when the file changes, or move the lazy fonts
  out of `public/` and `import` them through Vite so they get a content hash (then the runtime rule
  matches on the hashed `/assets/...woff2` path). Either way a content change becomes a new URL → fresh
  fetch, while unchanged files stay permanently cached. (The precached defaults don't need this —
  workbox revisioning handles them.)

### 2.6 Transfer-weight note (load-feel gate)

Rough per-file subset woff2 sizes (Latin-subset, single weight):

- IBM Plex Sans / Plex Mono / Space Grotesk: **~20–35 KB** per weight.
- Newsreader (has `opsz`; if shipped as a static instance per weight): **~25–40 KB** per weight; the
  δ-only subset for the wordmark is **~3–6 KB**.

**Everyday critical path (default Sans + Mono):** precaching all listed weights ≈ Sans 4 × ~28 KB +
Mono 3 × ~28 KB + δ-subset ~5 KB ≈ **~205 KB**, served from cache after the first-ever load (network
only once). To trim the *first-ever* download, preload + precache only the **400** weights of each
(~28 KB × 2 ≈ ~56 KB) and let 500/600/700 be fetched on demand (still SW-cached forever). Each lazy
voice is a one-time **~80–140 KB** (3–4 weights) the first time it's picked, then zero. All within the
load-feel budget because the everyday repeat load is **zero font network**. Report the actual bundle/
asset delta on hand-back per the lane gate.

---

## 3. `themeStore` (Zustand, device-local IDB)

Mirror the existing `notebookStore` (`src/lib/notebookStore.ts`) + `notebookPointer`
(`src/db/notebookPointer.ts`) pattern exactly: a tiny Zustand store backed by the **`deviceState`**
Dexie table (`db.deviceState`, key→value string rows) — **device-local IndexedDB, NOT synced, NOT
localStorage** (iOS evicts localStorage under pressure; see `e4-cold-reload-fix`). Three rows, or one
JSON row; one JSON row under a single key is simplest and matches the kv shape.

### 3.1 Types + default

```ts
// src/lib/themeStore.ts (store)  +  src/db/themePointer.ts (IDB read/write), mirroring notebook*.

export type Palette = 'bone' | 'graphite' | 'manila' | 'ember';
export type Voice   = 'serif' | 'sans' | 'mono' | 'grotesk';
export type Mode    = 'light' | 'dark' | 'system';

export interface ThemeState {
  palette: Palette;
  voice: Voice;
  mode: Mode;
}

// Decision #5: default = Ember × Sans × system.
export const DEFAULT_THEME: ThemeState = { palette: 'ember', voice: 'sans', mode: 'system' };
```

### 3.2 IDB pointer (`src/db/themePointer.ts`)

```ts
import { db } from './schema.js';
import { DEFAULT_THEME, type ThemeState } from '../lib/themeStore.js';

const THEME_KEY = 'appearance-theme';   // single deviceState row, JSON-encoded ThemeState

export async function readTheme(): Promise<ThemeState> {
  const row = await db.deviceState.get(THEME_KEY);
  if (!row) return DEFAULT_THEME;
  try {
    const v = JSON.parse(row.value) as Partial<ThemeState>;
    // validate each axis against the unions; fall back per-field to default (forward-compatible).
    return {
      palette: (['bone','graphite','manila','ember'] as const).includes(v.palette as Palette) ? v.palette as Palette : DEFAULT_THEME.palette,
      voice:   (['serif','sans','mono','grotesk'] as const).includes(v.voice as Voice)        ? v.voice as Voice     : DEFAULT_THEME.voice,
      mode:    (['light','dark','system'] as const).includes(v.mode as Mode)                  ? v.mode as Mode       : DEFAULT_THEME.mode,
    };
  } catch { return DEFAULT_THEME; }
}

export async function writeTheme(t: ThemeState): Promise<void> {
  await db.deviceState.put({ key: THEME_KEY, value: JSON.stringify(t) });
}
```

### 3.3 Store (`src/lib/themeStore.ts`)

```ts
import { create } from 'zustand';
import { readTheme, writeTheme } from '../db/themePointer.js';

interface ThemeStore extends ThemeState {
  _ready: boolean;                         // false until init() resolves
  init(): Promise<void>;
  setPalette(p: Palette): Promise<void>;
  setVoice(v: Voice): Promise<void>;       // also triggers lazy font-chunk import (§2.4)
  setMode(m: Mode): Promise<void>;
}

function applyToRoot(t: ThemeState) {
  const el = document.documentElement;     // the theme root (<html>)
  el.dataset.palette = t.palette;
  el.dataset.voice = t.voice;
  el.dataset.mode = t.mode;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  ...DEFAULT_THEME,                        // sensible default BEFORE IDB resolves → no flash
  _ready: false,

  async init() {
    const t = await readTheme();
    applyToRoot(t);
    set({ ...t, _ready: true });
  },

  async setPalette(palette) { const t = { ...pick(get()), palette }; await writeTheme(t); applyToRoot(t); set(t); },
  async setVoice(voice)     { const t = { ...pick(get()), voice };   await loadVoiceFont(voice); await writeTheme(t); applyToRoot(t); set(t); },
  async setMode(mode)       { const t = { ...pick(get()), mode };    await writeTheme(t); applyToRoot(t); set(t); },
}));

// helper: extract just the persisted ThemeState fields from the store
const pick = (s: ThemeState): ThemeState => ({ palette: s.palette, voice: s.voice, mode: s.mode });
```

- **Application:** the store applies the values as `data-palette` / `data-voice` / `data-mode` on the
  theme root (`<html>`) and reads from IDB on `init()`; the store seeds the **default** (Ember × Sans ×
  system) synchronously before IDB resolves, and `index.html` also ships those attrs statically, so the
  first paint is the correct default with **no flash** even before hydration.
- **`init()` call site:** call once on app mount (alongside `useNotebookStore().init()` in
  `AuthedShell`). It's cheap and offline-safe.
- **`mode=system` + `theme-color`:** the CSS in §1 handles `system` natively via
  `@media (prefers-color-scheme)`. If you also need to update the `<meta name="theme-color">` to match
  (mode-aware, scoping-spec §2), resolve the effective mode in JS:
  `window.matchMedia('(prefers-color-scheme: dark)').matches` when `mode==='system'`, else `mode`;
  set the meta to the current `--nav`/`--paper`. Optional for Lane 0; the picker lane can own it.
- **Lazy font hook:** `setVoice` calls `loadVoiceFont(voice)` (the `FONT_CHUNK` dynamic import from
  §2.4) so the chosen voice's woff2 is fetched on first selection then SW-cached forever.

---

## Appendix — Lane-0 acceptance (from scoping spec §3)

- Theme swap flips the CSS vars on the root (render test: change `data-palette`/`data-voice`/
  `data-mode`, assert a `var(--accent)` / `var(--ff)` consumer recomputes).
- Default applies: with no IDB row, root boots `ember/sans/system` and `var(--accent)` resolves to
  `#EE431C` (light) / `#FF6242` (dark, system+OS-dark).
- All 12 tokens defined for every palette × {light, dark}; all 12 type-scale vars per voice.
- Invariants hold: metadata `var(--mono)`, sync dot `var(--sync)`, δ wordmark Newsreader+`var(--accent)`,
  `<mark>` = `color-mix(... var(--accent) 24% ...)`.
- Bundle-delta report attached (load-feel gate); everyday repeat load = zero font network.
```
