import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { UserConfig } from 'vitest/config';
import { execSync } from 'node:child_process';

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
};

function gitShortSha(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return '0.0.0'; }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(gitShortSha()),
  },
  // vite's own UserConfigExport has no `test` key (vitest reads it at runtime); typing it here would
  // pull vitest/config's defineConfig, which resolves a DIFFERENT vite version than the app's and
  // mismatches the plugin types. So suppress the one runtime-valid excess key — self-correcting: if
  // vite ever types `test`, this @ts-expect-error goes unused and errors, flagging the cleanup. This
  // keeps `pnpm typecheck` (tsconfig.node.json) fully green so the gate means deploy-clean.
  // @ts-expect-error — `test` is read by vitest at runtime; not in vite's config type.
  test: testConfig,
  plugins: [
    react(),
    VitePWA({
      // injectManifest: we own the service worker source; the plugin only injects the
      // precache manifest into it. This is what lets us carry the /api/ navigation denylist.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        // woff2: precache the everyday fonts (Plex Sans default voice + Plex Mono metadata) at SW
        // install so the first everyday load is instant + offline (UI refresh, Lane 0).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
      },
      manifest: {
        name: 'deltos',
        short_name: 'deltos',
        description: 'A private, multi-surface notes framework.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#11131a',
        theme_color: '#11131a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
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
