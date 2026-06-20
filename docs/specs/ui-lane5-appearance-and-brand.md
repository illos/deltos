# Sub-spec — Appearance picker, lazy voices & brand assets (Lane 5, turnkey)

**Status:** READY TO BUILD. Turnkey implementation sub-spec for **Lane 5** of the UI visual refresh
(`docs/specs/ui-visual-refresh.md` §3). This lane is **Deploy 2 — "Appearance + brand"** (per the
resolved cadence, decision A): the user-facing theme picker in Settings, the completion of the lazy
font voices, and the gold-δ brand assets. It sits **on top of Lane 0** (token system + themeStore +
tokens.css, already built — see `docs/specs/ui-tokens-and-fonts.md`) and ships **after Deploy 1**
(Lanes 0+1+2, the "new look").

**What Lane 0 already gave us (do not rebuild — wire against it):**

- `packages/client/src/db/themePointer.ts` — schema owner: the `Palette | Voice | Mode` unions, the
  `PALETTES` / `VOICES` / `MODES` arrays, `DEFAULT_THEME = { palette:'ember', voice:'sans', mode:'system' }`,
  `readTheme()` / `writeTheme()` over a single device-local `deviceState` IDB row (`appearance-theme`).
- `packages/client/src/lib/themeStore.ts` — the Zustand store: `useThemeStore` with
  `init()` / `setPalette(p)` / `setVoice(v)` / `setMode(m)` / `_ready`, plus the exported helpers
  `applyToRoot(t)`, `resolvedMode(mode)`, **and the lazy-voice loader seam `loadVoiceFont(voice)` backed
  by `FONT_CHUNK`.** `setVoice` already `await`s `loadVoiceFont(voice)` before applying — the seam is
  live; this lane only fills in the two `import()`s.
- `packages/client/src/theme/tokens.css` — all 12 color tokens × 4 palettes × {light,dark} + system,
  the 4 voice type-scales, the invariants (`.dt-meta`, `.dt-sync-dot`, `.dt-wordmark-delta`,
  `mark`), and the **precached** `@font-face` blocks for IBM Plex Sans + IBM Plex Mono.
- `packages/client/src/main.tsx` — already imports `./theme/tokens.css` and calls
  `void useThemeStore.getState().init()` **before React mounts** (no-flash boot). **This lane does NOT
  touch main.tsx or App.tsx** — the store is already wired app-wide.
- `packages/client/public/fonts/` — the 7 everyday woff2 (`ibm-plex-sans-{400,500,600,700}`,
  `ibm-plex-mono-{400,500,600}`).
- `packages/client/index.html` (ui-refresh) — already ships static `data-palette/voice/mode` attrs,
  mode-aware critical-CSS, the two font preloads, and **placeholder** icon/manifest links. This lane
  **replaces** the placeholder brand wiring (see §3) and coordinates with Lane 2, which also edits
  index.html.

**Honored resolved decisions:**

- **#5 / B** — palette + voice are **placeholder boot defaults** (a future onboarding flow chooses them);
  the firm part is **mode = light / dark / system, system default.** The picker exposes **all three axes**
  (the picker IS the manual override surface), and all 32 combos are reachable.
- **#4 / C** — fonts self-hosted (subset woff2, same-origin), `font-display:swap`; default voice + Mono
  precached; **the 3 non-default voices lazy-load on first selection then persist via the SW cache-first
  rule forever.** This lane completes the 2 remaining lazy voices + the δ-wordmark subset.

**Load-feel gate (hard):** no new heavy deps. The picker is plain React + the existing Zustand store +
CSS; the lazy voices add **zero bytes to the default everyday load** (default users never fetch them).
Report bundle/asset delta on hand-back.

**Branch:** build on the isolated **`ui-refresh`** branch/worktree (per the scoping spec §0 branch-
isolation note), NOT `phase-0-foundation`. Deploy 2 ships after #52 is verified live and Deploy 1 has
landed.

---

## 1. The Appearance section UI

### 1.1 Where it slots into SettingsRoute's view machine

`packages/client/src/routes/SettingsRoute.tsx` is a `useState<View>` state machine that early-returns a
sub-view component for every non-`list` tag, then renders the main settings list at the bottom. The
Appearance picker is **inline in the main list** (no new `View` tag, no sub-view, no navigation) — it is
purely additive and self-contained, so it cannot collide with a teammate editing the auth-disclosure
copy in the sub-views.

**Insertion point:** add a new `<AppearanceSection />` **between the Account `<section>` and the Security
`<section>`** in the main-list return (i.e. immediately after the `aria-label="Account"` section closes,
before the `aria-label="Security"` section). This matches the codebase-map placement ("slot between
Account and Security", scoping spec §2 table).

```tsx
// SettingsRoute.tsx — main list return, additive:
      {/* Section 1 — Account */}
      <section className="settings__section" aria-label="Account"> … </section>

      {/* Section 2 — Appearance (Lane 5, additive) */}
      <AppearanceSection />

      {/* Section 3 — Security */}
      <section className="settings__section" aria-label="Security"> … </section>
```

Add one import at the top of SettingsRoute.tsx:

```tsx
import { AppearanceSection } from '../components/AppearanceSection.js';
```

That is the **entire** edit to SettingsRoute.tsx — one import line + one component tag. Everything else
lives in the new self-contained component, so it stays out of the auth-disclosure teammate's path.

### 1.2 Component structure

Create `packages/client/src/components/AppearanceSection.tsx`. It renders one
`<section className="settings__section" aria-label="Appearance">` containing three labeled picker groups
(Palette / Type / Mode), each a row of `<button>` "chips" (NOT text inputs — no iOS ≥16px concern, and
the prototype uses pill buttons). It subscribes to `useThemeStore` for the three active values and calls
the setters on tap. Live preview is automatic: each setter calls `applyToRoot`, flipping the
`data-palette`/`data-voice`/`data-mode` attrs on `<html>`, so `tokens.css` repaints the whole app
instantly with no reload (the Settings screen itself repaints too — instant feel-test).

```tsx
// packages/client/src/components/AppearanceSection.tsx
import { useThemeStore } from '../lib/themeStore.js';
import { PALETTES, VOICES, MODES, type Palette, type Voice, type Mode } from '../db/themePointer.js';

// Human labels + per-axis presentation metadata. Keep these here (display concern), not in the store.
const PALETTE_LABEL: Record<Palette, string> = {
  bone: 'Bone', graphite: 'Graphite', manila: 'Manila', ember: 'Ember',
};
// Each voice label is rendered IN its own font via the var the voice block defines, so the chip is a
// live type specimen. We hard-name the family here (the chip overrides --ff locally) so the specimen is
// correct even before that voice's lazy woff2 has loaded (falls back to the family's system fallback).
const VOICE_LABEL: Record<Voice, { name: string; family: string }> = {
  serif:   { name: 'Serif',   family: "'Newsreader', Georgia, serif" },
  sans:    { name: 'Sans',    family: "'IBM Plex Sans', system-ui, sans-serif" },
  mono:    { name: 'Mono',    family: "'IBM Plex Mono', ui-monospace, monospace" },
  grotesk: { name: 'Grotesk', family: "'Space Grotesk', system-ui, sans-serif" },
};
const MODE_LABEL: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

export function AppearanceSection() {
  const palette = useThemeStore((s) => s.palette);
  const voice = useThemeStore((s) => s.voice);
  const mode = useThemeStore((s) => s.mode);
  const setPalette = useThemeStore((s) => s.setPalette);
  const setVoice = useThemeStore((s) => s.setVoice);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <section className="settings__section appearance" aria-label="Appearance">
      <h2 className="settings__section-title">Appearance</h2>

      {/* PALETTE · VIBE — 4 swatch chips, each previewing its own accent + surface */}
      <div className="appearance__group" role="radiogroup" aria-label="Palette">
        <span className="appearance__group-label">Palette</span>
        <div className="appearance__chips">
          {PALETTES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={palette === p}
              className={`appearance__chip appearance__chip--swatch${palette === p ? ' is-active' : ''}`}
              // Render the chip's OWN palette colors as a live swatch (independent of the active theme),
              // using that palette's light-mode accent + surface as CSS vars on the element.
              data-swatch-palette={p}
              onClick={() => { void setPalette(p); }}
            >
              <span className="appearance__swatch" aria-hidden />
              <span className="appearance__chip-label">{PALETTE_LABEL[p]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* TYPE · VOICE — each label rendered in its own font */}
      <div className="appearance__group" role="radiogroup" aria-label="Type voice">
        <span className="appearance__group-label">Type</span>
        <div className="appearance__chips">
          {VOICES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={voice === v}
              className={`appearance__chip${voice === v ? ' is-active' : ''}`}
              style={{ fontFamily: VOICE_LABEL[v].family }}
              onClick={() => { void setVoice(v); }}
            >
              {VOICE_LABEL[v].name}
            </button>
          ))}
        </div>
      </div>

      {/* MODE — light / dark / system (system = follow OS, the default) */}
      <div className="appearance__group" role="radiogroup" aria-label="Mode">
        <span className="appearance__group-label">Mode</span>
        <div className="appearance__chips appearance__chips--segmented">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`appearance__chip${mode === m ? ' is-active' : ''}`}
              onClick={() => { void setMode(m); }}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
```

**Notes:**

- **Mobile-first / no text inputs:** every control is a `<button>` chip — there is **no** focusable
  `<input>/<textarea>/<select>`, so the iOS ≥16px auto-zoom rule does not apply here. (Chip font-size
  may stay at the prototype's compact ~12.5–13px without zoom risk.) Use `role="radiogroup"` +
  `role="radio"` + `aria-checked` for the segmented semantics.
- **Active state** mirrors the prototype's `syncControls()`: the active chip gets `is-active`
  (filled bg = `--ink`/`--sel`, label = `--paper`/`--ink`, border = `--accent`, weight 600). Inactive =
  transparent/`--paper` bg, `--secondary` label, `--border` hairline.
- The **Type** chips set `fontFamily` inline so each chip is a live specimen of its voice (Serif chip in
  Newsreader, Mono chip in Plex Mono, etc.). For a voice whose woff2 hasn't loaded yet, the chip shows
  the system fallback in the family stack until `setVoice` triggers the lazy fetch — acceptable
  (`font-display:swap`).
- The **Palette** swatch (`appearance__swatch`) previews each palette's own accent + surface regardless
  of the currently active theme. Drive it from a small CSS map keyed on `data-swatch-palette` (§1.3) so
  the swatch colors are static per-palette, not `var(--accent)` (which would just show the active theme
  four times).
- **Persistence is automatic** — each setter calls `writeTheme` (device-local IDB) then `applyToRoot`;
  reload re-applies via `init()` in main.tsx. Nothing to add.

### 1.3 CSS (append to `packages/client/src/styles.css`)

The existing `.settings__*` classes already theme-token correctly (Lane 2 retokenized styles.css). Add
an `.appearance` block. The swatch colors are the **light** accent + paper of each palette, copied from
`tokens.css` (a static specimen, deliberately not `var(--accent)`):

```css
/* ── Appearance picker (Lane 5) ─────────────────────────────────────────── */
.appearance__group { display: flex; flex-direction: column; gap: 8px; padding: 10px 0; }
.appearance__group:not(:last-child) { border-bottom: 1px solid var(--border); }
.appearance__group-label {       /* metadata label — invariant: Plex Mono, uppercase, tracked */
  font-family: var(--mono); font-size: 10px; letter-spacing: 1.5px;
  text-transform: uppercase; color: var(--faint);
}
.appearance__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.appearance__chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 13px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--paper);
  color: var(--secondary); font-size: 13px; line-height: 1; letter-spacing: 0.2px;
  white-space: nowrap; cursor: pointer; transition: all 0.12s ease;
  min-height: 36px;            /* comfortable tap target */
}
.appearance__chip.is-active {
  background: var(--sel); color: var(--ink); border-color: var(--accent); font-weight: 600;
}
.appearance__chip:active { background: var(--sel); }
/* Palette swatch dot = that palette's own light accent ring over its own surface */
.appearance__swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border); }
.appearance__chip--swatch[data-swatch-palette="bone"]     .appearance__swatch { background: #A8662F; box-shadow: inset 0 0 0 3px #FAF7F0; }
.appearance__chip--swatch[data-swatch-palette="graphite"] .appearance__swatch { background: #3B5BDB; box-shadow: inset 0 0 0 3px #FFFFFF; }
.appearance__chip--swatch[data-swatch-palette="manila"]   .appearance__swatch { background: #9E3B2E; box-shadow: inset 0 0 0 3px #F8F7F0; }
.appearance__chip--swatch[data-swatch-palette="ember"]    .appearance__swatch { background: #EE431C; box-shadow: inset 0 0 0 3px #FFFFFF; }
```

> styles.css critical-CSS caution (scoping spec §2): the Appearance classes are **not** critical-path
> (Settings is a lazy route), so they live **only** in styles.css — do **not** duplicate them into the
> `index.html` inline critical CSS.

---

## 2. Completing the lazy voices

Lane 0 left the seam inert (`FONT_CHUNK.serif` / `.grotesk` = `null`). This lane fills them in. Sans and
Mono stay `null` (Sans precached; Mono voice reuses the precached metadata faces — selecting Mono just
sets `data-voice="mono"`, no fetch).

### 2.1 Obtain the self-hosted subset woff2

Same provenance + method as Lane 0 (`public/fonts/README.md`): copy the pre-subset **`latin`**
`*-normal.woff2` (and `*-italic.woff2` for Newsreader) from the fontsource packages, which already exist
in client `devDependencies` as the file source (not imported — do not flag as dead):

- **`@fontsource/newsreader`** → `newsreader-{400,500,600}.woff2` + `newsreader-{400,500,600}-italic.woff2`
  (Serif voice uses italic for `blockquote` and the `I` mark; ship the 3 italic weights).
- **`@fontsource/space-grotesk`** → `space-grotesk-{400,500,600,700}.woff2`.

Newsreader is a variable font with an `opsz` axis upstream; ship **static instances per weight** (the
fontsource `latin` files are already static per weight — simplest, smallest, no `@font-face` `opsz`
descriptor needed). Add both packages to client `devDependencies` if not already present, and extend
`public/fonts/README.md`'s "Deferred to Lane 5" section to "Shipped" with the new filenames.

Add these to `packages/client/public/fonts/`:

```
newsreader-400.woff2 newsreader-500.woff2 newsreader-600.woff2
newsreader-400-italic.woff2 newsreader-500-italic.woff2 newsreader-600-italic.woff2
newsreader-delta.woff2                # δ-only subset (U+03B4) for the wordmark invariant
space-grotesk-400.woff2 space-grotesk-500.woff2 space-grotesk-600.woff2 space-grotesk-700.woff2
```

**δ-wordmark subset (`newsreader-delta.woff2`):** subset Newsreader 600 to the single codepoint U+03B4
with `pyftsubset` (the fontsource latin files do **not** include Greek, so this must be subset from the
upstream full Newsreader — `glyphhanger`/`fonttools`):

```
pyftsubset Newsreader-SemiBold.ttf --unicodes=U+03B4 --flavor=woff2 --output-file=newsreader-delta.woff2
```

This is ~2–6 KB and makes the brand δ correct in Newsreader serif **regardless of the active voice**,
so it is loaded **always** (declared in tokens.css, not lazily). Currently the δ falls back to Georgia
serif via `.dt-wordmark-delta`; this completes the invariant.

### 2.2 `@font-face` — the δ-subset (always-loaded) goes in tokens.css

Add to `packages/client/src/theme/tokens.css`, right after the precached Plex Mono block (so it is part
of the always-loaded sheet and SW-precached like the everyday faces):

```css
/* ---- Newsreader δ-wordmark subset (invariant — ALWAYS loaded, brand glyph) ---- */
@font-face {
  font-family: 'Newsreader'; font-style: normal; font-weight: 600; font-display: swap;
  src: url('/fonts/newsreader-delta.woff2') format('woff2');
  unicode-range: U+03B4;   /* only the δ — the FULL Newsreader (Serif voice) loads lazily, §2.3 */
}
```

> `unicode-range` scopes this face to just δ, so it never competes with the full Newsreader faces loaded
> with the Serif voice (the browser picks the δ subset for δ, the lazy full faces for everything else).
> Update the tokens.css render-test expectation: it currently asserts
> `css.not.toMatch(/src:url\([^)]*newsreader[^)]*\.woff2/i)` — that line must be **removed/relaxed**
> (the δ subset now legitimately references a newsreader woff2). Keep the assertion that the **Serif
> voice's full faces** are NOT in tokens.css (they live in the lazy chunk, §2.3).

### 2.3 Lazy voice CSS chunks + the loader seam

Create one CSS-only module per lazy voice (each containing just that family's full `@font-face` set).
These are imported **dynamically** so Vite emits each as its own CSS asset, fetched only on first
selection.

`packages/client/src/styles/fonts/newsreader.css`:

```css
/* Full Newsreader faces — Serif voice. Lazy: imported by themeStore on first Serif selection,
   then SW-cached cache-first forever. The δ-subset face (tokens.css) covers the wordmark always. */
@font-face { font-family:'Newsreader'; font-style:normal; font-weight:400; font-display:swap; src:url('/fonts/newsreader-400.woff2') format('woff2'); }
@font-face { font-family:'Newsreader'; font-style:normal; font-weight:500; font-display:swap; src:url('/fonts/newsreader-500.woff2') format('woff2'); }
@font-face { font-family:'Newsreader'; font-style:normal; font-weight:600; font-display:swap; src:url('/fonts/newsreader-600.woff2') format('woff2'); }
@font-face { font-family:'Newsreader'; font-style:italic; font-weight:400; font-display:swap; src:url('/fonts/newsreader-400-italic.woff2') format('woff2'); }
@font-face { font-family:'Newsreader'; font-style:italic; font-weight:500; font-display:swap; src:url('/fonts/newsreader-500-italic.woff2') format('woff2'); }
@font-face { font-family:'Newsreader'; font-style:italic; font-weight:600; font-display:swap; src:url('/fonts/newsreader-600-italic.woff2') format('woff2'); }
```

`packages/client/src/styles/fonts/space-grotesk.css`:

```css
/* Full Space Grotesk faces — Grotesk voice. Lazy: imported on first Grotesk selection, SW-cached. */
@font-face { font-family:'Space Grotesk'; font-style:normal; font-weight:400; font-display:swap; src:url('/fonts/space-grotesk-400.woff2') format('woff2'); }
@font-face { font-family:'Space Grotesk'; font-style:normal; font-weight:500; font-display:swap; src:url('/fonts/space-grotesk-500.woff2') format('woff2'); }
@font-face { font-family:'Space Grotesk'; font-style:normal; font-weight:600; font-display:swap; src:url('/fonts/space-grotesk-600.woff2') format('woff2'); }
@font-face { font-family:'Space Grotesk'; font-style:normal; font-weight:700; font-display:swap; src:url('/fonts/space-grotesk-700.woff2') format('woff2'); }
```

Wire them into the existing `FONT_CHUNK` map in `packages/client/src/lib/themeStore.ts` (replace the two
`null` TODOs — this is the **only** change to themeStore.ts):

```ts
const FONT_CHUNK: Record<Voice, (() => Promise<unknown>) | null> = {
  sans: null, // precached
  mono: null, // reuses the precached Plex Mono metadata faces
  serif:   () => import('../styles/fonts/newsreader.css'),
  grotesk: () => import('../styles/fonts/space-grotesk.css'),
};
```

`setVoice` already `await loadVoiceFont(voice)` before `applyToRoot`, so first selection fetches the
chunk; the dynamic `import()` is idempotent (bundler-cached after first call). `font-display:swap` means
the voice paints immediately in the fallback then swaps when the woff2 arrives.

### 2.4 Permanent caching (SW) — confirm the runtime rule exists

The SW (`packages/client/src/sw.ts`, injectManifest) currently does `precacheAndRoute` + a navigation
route only — **there is no `/fonts/` runtime rule yet.** Precaching covers the **everyday** faces (they
match the `woff2`-inclusive glob → precache manifest **only if** the glob includes woff2; verify, see
below), but the **lazy** files are NOT in `public/` at build's precache-time for the *first* deploy that
ships them, and even when globbed, the lazy chunks' faces are requested at runtime. Add a
**CacheFirst, no-expiry** runtime route for `/fonts/` so any font (lazy or precache-missed) persists
forever once fetched:

```ts
// sw.ts — add alongside the existing imports + routes:
import { registerRoute } from 'workbox-routing';      // already imported
import { CacheFirst } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

// Fonts: cache-first, NO ExpirationPlugin → never auto-evicted (permanent on device, across deploys).
registerRoute(
  ({ url }) => url.pathname.startsWith('/fonts/'),
  new CacheFirst({
    cacheName: 'deltos-fonts',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);
```

(`workbox-strategies` / `workbox-cacheable-response` are transitive deps of `vite-plugin-pwa`/workbox —
already present; no new top-level dep.)

**Also confirm the precache glob includes woff2.** `vite.config.ts` currently has
`injectManifest.globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}']` — **woff2 is NOT listed**,
so the everyday fonts are NOT precached today; they rely on the runtime CacheFirst rule above (which is
fine — first-ever load fetches them once, then permanent). For install-time offline-readiness of the
**everyday** faces, add `woff2` to the glob:

```ts
injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'] },
```

With woff2 in the glob, the everyday + δ-subset files (in `public/fonts/` at build time) are precached
(workbox-revisioned → re-fetched only on content change); the **lazy** chunk files are also in
`public/fonts/` so they too get precached — but the runtime CacheFirst rule is still the belt that keeps
them permanent if a client's precache predates the file. Either way: everyday repeat load = zero font
network.

> **Lazy-file revisioning caveat (carry-forward from Lane 0 §2.5):** `public/fonts/*` are not
> content-hashed and the runtime rule is cache-first by URL. If a lazy font file's **contents** ever
> change under the same filename, cached clients keep stale bytes. Mitigation: version the filename
> (`space-grotesk-500.v2.woff2`) on content change. Not a Deploy-2 blocker (first ship); note it.

### 2.5 Bundle impact (load-feel)

- **Default everyday load: +0 bytes.** Default users are Ember × **Sans** → never import the lazy chunks
  or fetch Newsreader/Grotesk full faces. The only addition to the always-loaded set is the
  **δ-subset (~2–6 KB)**, which fixes the brand glyph.
- **First Serif selection:** one-time ~6 files × ~25–40 KB ≈ **~150–220 KB** (3 weights × normal+italic),
  then permanent (zero network forever after). **First Grotesk selection:** 4 weights ≈ **~90–140 KB**,
  then permanent. Mono selection = **0** (reuses precached Plex Mono).
- **JS delta:** the picker component + label maps ≈ **<1 KB gzip**; the dynamic `import()`s add no JS to
  the main chunk. Report actual asset delta on hand-back.

---

## 3. Brand assets

Wire the gold-serif-δ icons from `docs/design/ui-refresh/icons/` into the app. **Coordinate with Lane 2**
— index.html is also edited by Lane 2 (shell restyle + the static theme attrs already present). Land the
index.html `<link>`/`<meta>` changes **after Lane 2** (or as a clean additive patch over its head) to
avoid a merge collision in `<head>`.

### 3.1 Copy targets into `public/`

Source files (already in repo): `docs/design/ui-refresh/icons/{icon-1024,icon-512,icon-192,
icon-maskable-512,apple-touch-icon-180,favicon-64,favicon-32}.png`. The existing
`packages/client/public/icons/` holds the **placeholder** set (`icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`, `apple-touch-icon.png`, `favicon.svg`). Copy the new brand PNGs in, replacing
placeholders and adding the new sizes:

```
packages/client/public/icons/
  icon-192.png            ← icons/icon-192.png            (replace placeholder)
  icon-512.png            ← icons/icon-512.png            (replace placeholder)
  icon-maskable-512.png   ← icons/icon-maskable-512.png   (replace placeholder)
  apple-touch-icon-180.png ← icons/apple-touch-icon-180.png (NEW; replaces apple-touch-icon.png)
  favicon-32.png          ← icons/favicon-32.png          (NEW)
  favicon-64.png          ← icons/favicon-64.png          (NEW)
  icon-1024.png           ← icons/icon-1024.png           (NEW; manifest master / store listing)
```

Remove the placeholder `apple-touch-icon.png` and `favicon.svg` (or leave favicon.svg as an SVG
fallback — but index.html below points at the PNGs). The 1024 master is referenced by the manifest as a
high-res icon entry.

### 3.2 `manifest.webmanifest` icons[] (in `vite.config.ts` → `VitePWA({ manifest })`)

Replace the `icons` array (and the brand colors) in vite.config.ts:

```ts
manifest: {
  name: 'deltos',
  short_name: 'deltos',
  description: 'A private, multi-surface notes framework.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#1A1A1D',   // Ember dark --paper (brand graphite-charcoal); was '#11131a'
  theme_color: '#111113',        // Ember dark --nav (matches the dark theme-color meta in §3.3)
  icons: [
    { src: 'icons/icon-192.png',          sizes: '192x192',   type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png',          sizes: '512x512',   type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-1024.png',         sizes: '1024x1024', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512',   type: 'image/png', purpose: 'maskable' },
  ],
},
```

(`background_color`/`theme_color` reflect the brand: the icon is a gold δ on a graphite-gradient square,
so the splash/chrome should be the dark graphite, not the old ad-hoc `#11131a`. Keeping `#111113` =
Ember dark `--nav` aligns the PWA chrome with the default theme.)

### 3.3 `index.html` head — apple-touch / favicon / mode-aware theme-color

The ui-refresh index.html currently has placeholder links + mode-aware theme-color already. **Replace**
the icon links to point at the new brand files and keep the theme-color metas (they already match Ember
`--nav` light/dark — leave as-is or restate for clarity):

```html
<!-- Brand icons (Lane 5) -->
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png" />
<link rel="icon" type="image/png" sizes="64x64" href="/icons/favicon-64.png" />
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />

<!-- Mode-aware browser/status-bar chrome = Ember --nav (boot default). Already present; keep. -->
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F2F2F4" />
<meta name="theme-color" media="(prefers-color-scheme: dark)"  content="#111113" />
```

- Remove the placeholder `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />` and
  `<link rel="icon" href="/icons/favicon.svg" ... />` lines.
- **Mode-aware theme-color** uses two `<meta name="theme-color" media=...>` tags (light/dark) — these
  match the boot default (Ember). A future refinement could update `theme-color` per *chosen* palette
  via JS in themeStore (`resolvedMode` + the active `--nav`), but that is **out of scope for Lane 5**;
  the media-query pair is sufficient and matches the scoping spec's "mode-aware theme-color" ask.
- Keep `viewport-fit=cover` and the existing apple-mobile-web-app-* hints untouched.

### 3.4 Verify the woff2/png precache glob

The manifest icons are PNG (already in the `png` glob). With §2.4's `woff2` glob addition the fonts join
the precache. No other vite.config change.

---

## 4. Tests + gate

Per the project's **rendered-UI gate** (`ui-features-need-rendered-ui-gate`): unit-green + backend-verify
≠ usable — require routed-tree render tests asserting DOM + the live theme-root flip + persistence,
rules-of-hooks lint, prod-tsc, bundle delta, and an on-device smoke before deploy.

### 4.1 Appearance render test — `packages/client/test/AppearanceSection.render.test.tsx`

(jsdom via the `*.render.test.tsx` glob in vite.config.ts; `fake-indexeddb/auto` for the IDB-backed
store, matching `theme.render.test.tsx`.)

Assert:

1. **Renders in the routed tree** — render `<AppearanceSection />` (or the full `<SettingsRoute />` in a
   `MemoryRouter`, with the auth store stubbed authed): the section with `aria-label="Appearance"`
   exists, and all 4 palette + 4 voice + 3 mode chips render with their labels.
2. **Selecting a palette flips the theme root + persists** — click the "Graphite" chip;
   `document.documentElement.dataset.palette === 'graphite'` AND `await readTheme()` returns
   `palette: 'graphite'`. (Reset store + IDB + dataset in `beforeEach`, mirroring theme.render.test.tsx.)
3. **Selecting a voice flips `data-voice` + persists** — click "Mono"; `dataset.voice === 'mono'`,
   persisted. (Mono is the safe no-fetch voice for the test; selecting Serif/Grotesk would attempt a
   dynamic CSS import — either mock `loadVoiceFont`/`FONT_CHUNK` or assert on Mono to avoid the import in
   jsdom.)
4. **Selecting a mode flips `data-mode` + persists** — click "Dark"; `dataset.mode === 'dark'`,
   persisted. Click "System" → `dataset.mode === 'system'`.
5. **Active state reflects the store** — the active chip carries `is-active` / `aria-checked="true"`,
   exactly one per group.

### 4.2 tokens.css test update — `packages/client/test/theme.render.test.tsx`

- **Relax** the "no newsreader woff2" assertion: the δ-subset face now legitimately references
  `newsreader-delta.woff2` in tokens.css. Change the assertion to allow the δ subset while still
  asserting the **full** Serif faces (`newsreader-400.woff2` etc.) are NOT in tokens.css (they live in
  the lazy chunk). E.g. assert tokens.css contains `newsreader-delta.woff2` + `unicode-range: U+03B4`,
  and does NOT contain `newsreader-400.woff2` or `space-grotesk`.
- **Optional new test:** assert the two lazy chunk files exist and contain their family's faces
  (`readFileSync` `src/styles/fonts/newsreader.css` contains `newsreader-600.woff2`;
  `space-grotesk.css` contains `space-grotesk-700.woff2`).

### 4.3 Static / build gates

- **rules-of-hooks lint** clean (eslint config fixed @5360d6e per scoping spec §0).
- **prod-tsc** clean (`pnpm typecheck` — the strict prod build, per `green-gate-needs-prod-typecheck`):
  verify the dynamic `import('../styles/fonts/*.css')` types resolve (Vite CSS modules — add a
  `*.css` ambient module decl if tsc complains, or `// @ts-expect-error` is not acceptable; prefer the
  ambient decl in `vite-env.d.ts`).
- **Full suite green** (vitest) — Appearance render test + updated theme test + the existing 292+.

### 4.4 Bundle-delta report (load-feel gate)

Report on hand-back: (a) default everyday load delta — should be **+δ-subset (~2–6 KB) only** in the
always-loaded set, **+0** otherwise (lazy voices unfetched for default users); (b) picker JS delta
(<1 KB gzip); (c) per-lazy-voice one-time fetch sizes (Serif ~150–220 KB, Grotesk ~90–140 KB, Mono 0).

### 4.5 On-device smoke (review = the LIVE site)

Per the project rule, Jim reviews on **https://deltos.blackgate.studio** (deploy = the review step;
never a local/preview server). Thin smoke after deploy:

1. Settings → Appearance renders 3 groups; default chips active = Ember / Sans / System.
2. Tap each **palette** → whole app (incl. Settings) repaints instantly; reload → choice persists.
3. Tap each **voice** → type changes app-wide; **first** Serif/Grotesk tap fetches the woff2 once
   (Network tab: `/fonts/newsreader-*` / `space-grotesk-*`), subsequent loads zero network (SW cache).
   Confirm the **δ wordmark** is Newsreader serif under every voice (δ subset).
4. Tap **Mode** → Light/Dark/System; System follows the OS toggle live.
5. Install the PWA → home-screen icon is the gold-δ brand; maskable safe-zone OK; favicon in the tab;
   status-bar chrome matches light/dark.

---

## Appendix — file inventory (this lane)

**New files:**
- `packages/client/src/components/AppearanceSection.tsx`
- `packages/client/src/styles/fonts/newsreader.css`
- `packages/client/src/styles/fonts/space-grotesk.css`
- `packages/client/test/AppearanceSection.render.test.tsx`
- `packages/client/public/fonts/newsreader-{400,500,600}.woff2` + `-{400,500,600}-italic.woff2`
- `packages/client/public/fonts/newsreader-delta.woff2`
- `packages/client/public/fonts/space-grotesk-{400,500,600,700}.woff2`
- `packages/client/public/icons/{icon-1024,favicon-32,favicon-64,apple-touch-icon-180}.png` (new),
  and replaced `icon-{192,512},icon-maskable-512.png`

**Edited files:**
- `packages/client/src/routes/SettingsRoute.tsx` — 1 import + 1 `<AppearanceSection/>` tag (additive).
- `packages/client/src/lib/themeStore.ts` — fill the 2 `FONT_CHUNK` entries (serif/grotesk).
- `packages/client/src/theme/tokens.css` — add the δ-subset `@font-face`.
- `packages/client/src/styles.css` — append the `.appearance` block.
- `packages/client/src/sw.ts` — add the `/fonts/` CacheFirst runtime route.
- `packages/client/vite.config.ts` — add `woff2` to the precache glob; new manifest `icons[]` + brand
  `theme_color`/`background_color`.
- `packages/client/index.html` — brand icon `<link>`s (coordinate with Lane 2).
- `packages/client/public/fonts/README.md` — move the 3 lazy voices + δ-subset from "Deferred" to
  "Shipped".
- `packages/client/test/theme.render.test.tsx` — relax the newsreader-woff2 assertion for the δ subset.
- `packages/client/package.json` — add `@fontsource/newsreader` + `@fontsource/space-grotesk` to
  devDependencies (file source only; not imported).
