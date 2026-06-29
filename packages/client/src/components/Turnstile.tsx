/**
 * Turnstile — the Cloudflare Turnstile anti-abuse widget for the auth ceremonies
 * (login / signup / reset). Phase-0 item D of the API-access security program.
 *
 * The server gate (`gate()` in worker passwordAuth.ts) verifies a `turnstileToken`
 * ONLY when `TURNSTILE_SECRET` is configured; until that secret is set the gate is
 * inert. Symmetrically, this widget is INERT until a sitekey is provided via
 * `VITE_TURNSTILE_SITEKEY` at build time:
 *   - no sitekey  → render nothing, never load the Turnstile script, report no token
 *                   (local dev / unconfigured builds keep working with the inert gate).
 *   - sitekey set → lazily inject the Turnstile script ONCE, render the widget, and
 *                   surface the solved token via {@link TurnstileProps.onToken}.
 *
 * The token is single-use and short-lived: Turnstile re-issues one on expiry (we clear
 * the parent's token on `expired-callback`) and the parent must `reset()` after a failed
 * submit so the user gets a fresh challenge rather than replaying a spent token.
 *
 * NOTE: the widget renders no <input> of its own, so the iOS ≥16px no-zoom rule does not
 * apply to it (no focusable text field); it sits inline in the existing `.auth` column.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Build-time public sitekey. Empty when unconfigured → the widget is inert (see file header). */
const SITEKEY: string = import.meta.env.VITE_TURNSTILE_SITEKEY ?? '';

/** True when a sitekey is configured — gates whether the auth routes mount the widget at all. */
export const turnstileEnabled = SITEKEY.length > 0;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Minimal shape of the global Turnstile API we use (explicit-render mode).
interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
      appearance?: 'always' | 'execute' | 'interaction-only';
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __deltosTurnstileScript?: Promise<void>;
  }
}

/** Inject the Turnstile script once (idempotent across mounts); resolves when `window.turnstile` is ready. */
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (window.__deltosTurnstileScript) return window.__deltosTurnstileScript;
  window.__deltosTurnstileScript = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${SCRIPT_SRC}?render=explicit`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile script failed to load'));
    document.head.appendChild(s);
  });
  return window.__deltosTurnstileScript;
}

export interface TurnstileHandle {
  /** Re-challenge: clears the prior token and asks Turnstile for a fresh one. Call after a failed submit. */
  reset(): void;
}

export interface TurnstileProps {
  /** Called with the solved token, or null when the token expires / errors (clear the parent's held token). */
  onToken: (token: string | null) => void;
}

/**
 * Renders the Turnstile widget when a sitekey is configured; otherwise renders nothing.
 * Parent holds the token in state and includes it in the auth call; on a failed submit the
 * parent calls `reset()` (via the ref) to invalidate the spent token and re-challenge.
 */
export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile({ onToken }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest onToken without forcing a re-render/re-mount of the widget.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
        onTokenRef.current(null);
      }
    },
  }), []);

  useEffect(() => {
    if (!turnstileEnabled) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || !containerRef.current) return;
        // Guard against a double-render under React StrictMode dev double-invoke.
        if (widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITEKEY,
          theme: 'auto',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        // Script failed (offline / blocked). Leave no widget; the parent's token stays null. The server
        // gate (when its secret is set) rejects a missing token, so a hard failure here fails closed.
      });
    return () => {
      cancelled = true;
      if (window.turnstile && widgetIdRef.current) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
        widgetIdRef.current = null;
      }
    };
  }, []);

  if (!turnstileEnabled) return null;
  return <div ref={containerRef} className="auth__turnstile" />;
});
