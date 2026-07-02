import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { UserConfig } from 'vitest/config';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path to this package's root (the config-file dir) — used to name the multi-page HTML entries.
const packageRoot = dirname(fileURLToPath(import.meta.url));

// pdf.js ships its CMaps + standard-14 font data as loose binary asset dirs. The PDF reader points pdf.js at
// SAME-ORIGIN copies of them (`/pdfjs/cmaps/`, `/pdfjs/standard_fonts/`) so the engine never reaches a CDN for
// resources (pdf-reader.md §7 / gate PDF-S). This tiny plugin copies them into the build output and serves
// them from node_modules in dev. They are NOT JS chunks (`.bcmap`/`.pfb`/`.ttf`) so they fall outside the SW
// precache glob — fetched only when a PDF actually needs a non-embedded font, never bundled into any JS chunk.
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  const dirs = ['cmaps', 'standard_fonts'] as const;
  return {
    name: 'deltos-pdfjs-assets',
    // No `apply` → runs in both dev (configureServer) and build (writeBundle).
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url ? /^\/pdfjs\/(cmaps|standard_fonts)\/([^?]+)/.exec(req.url) : null;
        if (!m || !m[1] || !m[2]) return next();
        const file = join(pdfjsRoot, m[1], m[2]);
        if (!file.startsWith(pdfjsRoot) || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? resolve('dist');
      for (const d of dirs) {
        const src = join(pdfjsRoot, d);
        if (existsSync(src)) cpSync(src, join(outDir, 'pdfjs', d), { recursive: true });
      }
    },
  };
}

// The control dashboard injects a stable per-project HTTPS port; fall back to Vite's default
// when running outside it. Binding 127.0.0.1 (not localhost→::1) is what `tailscale serve`
// proxies to, and `.ts.net` must be an allowed Host or the tailnet request is rejected.
const devPort = Number(process.env.DEVBOX_PORT) || 5173;

const testConfig: UserConfig['test'] = {
  // Default to node — existing Dexie/syncEngine tests run without jsdom.
  // Component/render tests opt-in via the *.render.test.tsx naming pattern.
  environment: 'node',
  environmentMatchGlobs: [
    ['**/*.render.test.tsx', 'jsdom'],
    ['**/*.render.test.ts', 'jsdom'],
  ],
  // Shared setup: PM-in-jsdom rect shim + post-test unmount (task #65 — stops the intermittent
  // unhandled-error exit-1 from the editor render tests). Self-guards for the node environment.
  setupFiles: ['./test/setup.ts'],
};

function gitShortSha(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return '0.0.0'; }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(gitShortSha()),
    // Build timestamp (ISO) so Settings can show WHEN this build was produced — the human-readable
    // "did my change actually land on this device?" check alongside the git short SHA.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // vite's own UserConfigExport has no `test` key (vitest reads it at runtime); typing it here would
  // pull vitest/config's defineConfig, which resolves a DIFFERENT vite version than the app's and
  // mismatches the plugin types. So suppress the one runtime-valid excess key — self-correcting: if
  // vite ever types `test`, this @ts-expect-error goes unused and errors, flagging the cleanup. This
  // keeps `pnpm typecheck` (tsconfig.node.json) fully green so the gate means deploy-clean.
  // @ts-expect-error — `test` is read by vitest at runtime; not in vite's config type.
  test: testConfig,
  build: {
    rollupOptions: {
      // TWO HTML entries: the notes SPA (index.html) and the SEPARATE OAuth authorization surface
      // (oauth.html → src/oauth/*). oauth.html is a standalone tiny app served fresh at /oauth/* and
      // EXCLUDED from the notes SW precache (injectManifest.globIgnores below) so it can never go stale.
      input: {
        main: resolve(packageRoot, 'index.html'),
        oauth: resolve(packageRoot, 'oauth.html'),
      },
      output: {
        // STABLE pdf.js chunk names (pdf-reader.md §6.1) so the SW can match them by glob/predicate. pdf.js is
        // collapsed into one `pdfjs-[hash].js` chunk; everything else keeps Vite's default names.
        manualChunks(id: string) {
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          return undefined;
        },
        chunkFileNames: (info) =>
          info.name === 'pdfjs' ? 'assets/pdfjs-[hash].js' : 'assets/[name]-[hash].js',
        // The pdf.js parser worker (imported `?url`) is emitted SAME-ORIGIN with a matchable `.js` name so the
        // SW runtime rule + globIgnores can target it; all other assets keep the default name.
        assetFileNames: (info) => {
          const n = info.name ?? '';
          if (/pdf\.worker(\.min)?\.m?js$/.test(n)) return 'assets/pdf.worker-[hash].js';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  plugins: [
    pdfjsAssets(),
    react(),
    VitePWA({
      // injectManifest: we own the service worker source; the plugin only injects the
      // precache manifest into it. This is what lets us carry the /api/ navigation denylist.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // MANUAL update posture (pwa-force-update). 'prompt' (not 'autoUpdate') means registerSW does
      // NOT auto-apply a new build or auto-reload — a waiting worker is activated ONLY when the user
      // taps "Update now" in Settings (src/lib/forceUpdate.ts posts SKIP_WAITING to sw.ts). Pairs with
      // the SW no longer self-skipWaiting()-ing on install. Precache/caching strategy is unchanged.
      registerType: 'prompt',
      injectManifest: {
        // woff2: precache the everyday fonts (Plex Sans default voice + Plex Mono metadata) at SW
        // install so the first everyday load is instant + offline (UI refresh, Lane 0).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        // pdf.js chunks are LAZY + runtime-cached on first PDF open (sw.ts), NEVER install-precached — so the
        // ~0.5 MB engine never bloats install for users who never open a PDF (pdf-reader.md §6.2 / gate PDF-P).
        // The SEPARATE OAuth surface (oauth.html + its own entry chunk/CSS) is likewise excluded from the
        // notes precache: it is served fresh by the worker (no-store) and its navigation is passed through to
        // the network by the SW (sw.ts denylist), so it must never live in the shell precache manifest.
        globIgnores: ['**/pdfjs-*.js', '**/pdf.worker*.js', 'oauth.html', '**/oauth-*.js', '**/oauth-*.css'],
      },
      manifest: {
        name: 'deltos',
        short_name: 'deltos',
        description: 'A private, multi-surface notes framework.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1A1A1D', // Ember dark --paper (brand graphite-charcoal); was '#11131a'
        theme_color: '#111113',      // Ember dark --nav (matches the dark theme-color meta in index.html)
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // Serve the SW in dev too, so offline boot can be exercised without a production build.
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: devPort,
    allowedHosts: ['.ts.net'],
    // The substrate API is the worker; the client only ever talks to it over /api.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: devPort,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
