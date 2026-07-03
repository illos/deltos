// @vitest-environment jsdom
/**
 * useInstalledPwa — the installed-PWA (standalone) gate for the custom keyboard + its Settings toggle.
 * Two OR'd standalone signals: iOS Safari's non-standard `navigator.standalone`, and the standard
 * `(display-mode: standalone)` media query (Android WebAPK + all modern installed PWAs). Reactive on the
 * media query's `change` event. jsdom (no matchMedia) default is TRUE — the parallel to useTouchPrimary's
 * "assume touch-first" jsdom default — which keeps the keypad render-test corpus reachable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const STANDALONE = '(display-mode: standalone)';

interface MockMQL {
  matches: boolean;
  media: string;
  listeners: Set<() => void>;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  fire(): void;
}

/** Install a controllable matchMedia + navigator.standalone, then dynamic-import a FRESH hook module. */
async function setupEnv(opts: { standaloneMatches: boolean; iosStandalone?: boolean }) {
  const store: Record<string, MockMQL> = {};
  const initial: Record<string, boolean> = { [STANDALONE]: opts.standaloneMatches };
  const matchMedia = (query: string): MockMQL => {
    if (!store[query]) {
      store[query] = {
        matches: initial[query] ?? false,
        media: query,
        listeners: new Set<() => void>(),
        addEventListener(_t, cb) { this.listeners.add(cb); },
        removeEventListener(_t, cb) { this.listeners.delete(cb); },
        fire() { for (const cb of [...this.listeners]) cb(); },
      };
    }
    return store[query];
  };
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
  Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: opts.iosStandalone });
  vi.resetModules();
  const { useInstalledPwa } = await import('../src/lib/useInstalledPwa.js');
  return { useInstalledPwa, store };
}

afterEach(() => {
  cleanup();
  // Clear the injected iOS flag so a later test's env is clean.
  Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

describe('useInstalledPwa — installed/standalone gate', () => {
  it('(display-mode: standalone) matches → true', async () => {
    const { useInstalledPwa } = await setupEnv({ standaloneMatches: true });
    const { result } = renderHook(() => useInstalledPwa());
    expect(result.current).toBe(true);
  });

  it('navigator.standalone === true (iOS webclip) + query NOT matching → true', async () => {
    const { useInstalledPwa } = await setupEnv({ standaloneMatches: false, iosStandalone: true });
    const { result } = renderHook(() => useInstalledPwa());
    expect(result.current).toBe(true);
  });

  it('neither signal → false (plain mobile browser tab)', async () => {
    const { useInstalledPwa } = await setupEnv({ standaloneMatches: false, iosStandalone: false });
    const { result } = renderHook(() => useInstalledPwa());
    expect(result.current).toBe(false);
  });

  it('a display-mode change event flips the value live (installed at runtime → true)', async () => {
    const { useInstalledPwa, store } = await setupEnv({ standaloneMatches: false });
    const { result } = renderHook(() => useInstalledPwa());
    expect(result.current).toBe(false);
    act(() => {
      store[STANDALONE].matches = true; // e.g. an Android display-mode transition
      store[STANDALONE].fire();
    });
    expect(result.current).toBe(true);
  });

  it('no matchMedia (jsdom/SSR default) → true', async () => {
    // Delete matchMedia entirely: the hook's SSR/jsdom branch must default to the installed environment.
    vi.resetModules();
    const orig = window.matchMedia;
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    try {
      const { useInstalledPwa } = await import('../src/lib/useInstalledPwa.js');
      const { result } = renderHook(() => useInstalledPwa());
      expect(result.current).toBe(true);
    } finally {
      window.matchMedia = orig;
    }
  });
});
