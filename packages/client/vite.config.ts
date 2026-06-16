import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { UserConfig } from 'vitest/config';

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

export default defineConfig({
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
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
