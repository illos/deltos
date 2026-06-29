/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /**
   * Cloudflare Turnstile PUBLIC sitekey (Phase-0 item D anti-abuse gate). Build-time only; safe to ship
   * to the client. When UNSET the Turnstile widget renders nothing and submits no token — paired with the
   * worker gate, which verifies a token only when TURNSTILE_SECRET is set, so the feature is inert until
   * BOTH are configured. Set it for the live build (e.g. `VITE_TURNSTILE_SITEKEY=0x... pnpm --filter
   * @deltos/client build`, or a packages/client/.env.production line).
   */
  readonly VITE_TURNSTILE_SITEKEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
