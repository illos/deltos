# Self-hosted fonts (UI visual refresh, Lane 0)

These `.woff2` files are **self-hosted, latin-subset** copies of the everyday voices, served at
`/fonts/*` and `@font-face`-declared in `src/theme/tokens.css`. They are precached by the service
worker (the `woff2` glob in `vite.config.ts` → workbox `injectManifest`), so the everyday repeat
load fetches zero font bytes and works offline.

Shipped now (Deploy 1 — default Sans voice + mandatory Mono metadata):

- `ibm-plex-sans-{400,500,600,700}.woff2`
- `ibm-plex-mono-{400,500,600}.woff2`

## Provenance

Copied verbatim from the **`@fontsource/ibm-plex-sans`** and **`@fontsource/ibm-plex-mono`**
packages' pre-subset `latin` `*-normal.woff2` files. Those packages are listed in the client
`devDependencies` **only as the source of these files** — they are NOT imported by any code, so do
not flag them as unused/dead deps; they document the exact upstream + version + subset and let the
files be regenerated. (IBM Plex is OFL-1.1 licensed.)

## Deferred to Lane 5 (Appearance picker)

The other three voices (Newsreader / Space Grotesk) and the Newsreader **δ-wordmark** subset are
fetched lazily on first selection then cached forever by the SW (CacheFirst, no expiry). The loader
seam is `FONT_CHUNK` in `src/lib/themeStore.ts`; Lane 5 drops in the dynamic `import()` + the woff2.
Until then the δ wordmark glyph falls back to Georgia serif via `.dt-wordmark-delta`.
