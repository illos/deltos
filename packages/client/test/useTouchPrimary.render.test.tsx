// @vitest-environment jsdom
/**
 * R1 — the Deck gate goes touch-first-modality (useTouchPrimary), not window width. Covers the three
 * composed signals: the coarse-pointer + touch base, the any-pointer:fine yield (iPad + trackpad), and the
 * trusted-hardware-keydown session latch. The latch is SCOPED to the Deck-active editor surface: it only
 * trips for keydowns whose target sits inside an `[inputmode="none"]` element (the ProseMirror contenteditable
 * while the Deck is up) — a trusted keydown on a normal input (iOS software keyboard) must NOT latch. Each
 * case resets the module (vi.resetModules) so the module-level latch starts fresh and tests are order-independent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const COARSE = '(pointer: coarse)';
const ANY_FINE = '(any-pointer: fine)';

interface MockMQL {
  matches: boolean;
  media: string;
  listeners: Set<() => void>;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  fire(): void;
}

/** Install a controllable matchMedia + navigator.maxTouchPoints, then dynamic-import a FRESH hook module. */
async function setupEnv(opts: { coarse: boolean; anyFine: boolean; maxTouchPoints: number }) {
  const store: Record<string, MockMQL> = {};
  const initial: Record<string, boolean> = { [COARSE]: opts.coarse, [ANY_FINE]: opts.anyFine };
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
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: opts.maxTouchPoints });
  // jsdom RESETS isTrusted → false at the START of dispatchEvent, so a pre-set flag doesn't survive. Register
  // a CAPTURE keydown listener FIRST (before the hook mounts its own capture listener) that re-flips the
  // impl's isTrusted flag mid-propagation, per the event's stashed intent — so the hook's listener (which
  // registers later, hence runs later in capture order) reads the trusted value we want.
  window.addEventListener('keydown', forceTrustedFromIntent, true);
  vi.resetModules();
  const { useTouchPrimary } = await import('../src/lib/useTouchPrimary.js');
  return { useTouchPrimary, store };
}

const WANT_TRUSTED = Symbol('wantTrusted');
function forceTrustedFromIntent(e: Event) {
  const want = (e as unknown as Record<symbol, boolean | undefined>)[WANT_TRUSTED];
  if (want === undefined) return;
  for (const s of Object.getOwnPropertySymbols(e)) {
    const impl = (e as unknown as Record<symbol, { isTrusted?: boolean }>)[s];
    if (impl && typeof impl === 'object' && 'isTrusted' in impl) impl.isTrusted = want;
  }
}

const createdNodes: HTMLElement[] = [];

/** A Deck-active editor surface: an `[inputmode="none"]` element (with a child target), attached to the doc. */
function deckSurface(): HTMLElement {
  const surface = document.createElement('div');
  surface.setAttribute('inputmode', 'none');
  const child = document.createElement('span'); // the keydown target sits INSIDE the inputmode=none surface
  surface.appendChild(child);
  document.body.appendChild(surface);
  createdNodes.push(surface);
  return child;
}

/** An ordinary form field: a plain `<input>` with NO inputmode=none ancestor (the iOS software-keyboard case). */
function normalInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  createdNodes.push(input);
  return input;
}

/**
 * Dispatch a keydown carrying an isTrusted INTENT (applied mid-propagation by the capture forcer above).
 * Default target is a fresh Deck surface (inputmode=none) so latch cases exercise the scoped path; pass a
 * `target` to dispatch from a normal input (the false-positive case the scoping guards against).
 */
function dispatchKeydown(key: string, trusted: boolean, init: KeyboardEventInit = {}, target?: EventTarget) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, ...init });
  (e as unknown as Record<symbol, boolean>)[WANT_TRUSTED] = trusted;
  (target ?? deckSurface()).dispatchEvent(e);
}

afterEach(() => {
  cleanup();
  for (const n of createdNodes.splice(0)) n.remove();
  vi.restoreAllMocks();
});

describe('useTouchPrimary — touch-first modality gate', () => {
  it('fine-pointer desktop → false (width is never queried)', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: false, anyFine: true, maxTouchPoints: 0 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(false);
  });

  it('coarse pointer + touch points → true', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
  });

  it('coarse pointer but maxTouchPoints=0 → false (no real touch)', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 0 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(false);
  });

  it('coarse + touch but any-pointer:fine matches (trackpad attached) → false', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: true, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(false);
  });

  it('a media-query change event flips the value live (attach a fine pointer → yields)', async () => {
    const { useTouchPrimary, store } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
    act(() => {
      store[ANY_FINE].matches = true; // a Magic Keyboard / mouse gets attached
      store[ANY_FINE].fire();
    });
    expect(result.current).toBe(false);
    act(() => {
      store[ANY_FINE].matches = false; // detached again
      store[ANY_FINE].fire();
    });
    expect(result.current).toBe(true);
  });

  it('a TRUSTED hardware keydown on the inputmode=none surface latches → false for a subsequently-mounted instance', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const first = renderHook(() => useTouchPrimary());
    expect(first.result.current).toBe(true);
    act(() => { dispatchKeydown('Enter', true); }); // physical Enter key, on the Deck-active editor surface
    expect(first.result.current).toBe(false); // already-mounted instance flips via the latch notify
    const second = renderHook(() => useTouchPrimary());
    expect(second.result.current).toBe(false); // a fresh instance reads the latch on its initial state
  });

  it('a single printable trusted keydown (no modifier) on the inputmode=none surface latches', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
    act(() => { dispatchKeydown('a', true); });
    expect(result.current).toBe(false);
  });

  it('a trusted printable keydown on a NORMAL input does NOT latch (iOS software-keyboard case)', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
    const input = normalInput(); // e.g. the search field / login / settings input — no inputmode=none ancestor
    act(() => { dispatchKeydown('a', true, {}, input); }); // iOS soft keyboard fires trusted keydowns too
    expect(result.current).toBe(true); // must NOT latch — false positive on a real touch-first phone
    act(() => { dispatchKeydown('Enter', true, {}, input); });
    expect(result.current).toBe(true);
  });

  it('a SYNTHETIC keydown (isTrusted=false) does NOT latch', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
    act(() => { dispatchKeydown('Enter', false); }); // e.g. a dispatched event — never trusted
    act(() => { dispatchKeydown('a', false); });
    expect(result.current).toBe(true);
  });

  it('a modifier-held printable keydown does NOT latch (ambiguous — e.g. a shortcut)', async () => {
    const { useTouchPrimary } = await setupEnv({ coarse: true, anyFine: false, maxTouchPoints: 5 });
    const { result } = renderHook(() => useTouchPrimary());
    expect(result.current).toBe(true);
    act(() => { dispatchKeydown('a', true, { metaKey: true }); }); // Cmd+A etc. on the Deck surface
    expect(result.current).toBe(true);
  });
});
