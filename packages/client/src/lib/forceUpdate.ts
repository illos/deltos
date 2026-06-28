/**
 * Manual PWA "force update" — the ONLY path that activates a waiting service worker.
 *
 * The SW installs-and-waits by default (sw.ts no longer self-skipWaiting()s on install), so an
 * installed app never auto-swaps the running build. This is the sole trigger that applies a new
 * build on demand:
 *
 *   1. registration.update() — force a FRESH check against the server. iOS barely background-checks
 *      an installed PWA, so this explicit call is what makes "pull the latest" reliable on iPhone.
 *   2. If a new build is waiting (or finishes installing), post SKIP_WAITING so the SW activates it
 *      — skipWaiting() runs ONLY in response to this message, never automatically.
 *   3. Reload once the new worker reaches 'activated', so the page loads the new build.
 *
 * Online-only and no-ops gracefully offline; the SW keeps serving the cache offline, unchanged.
 * Deps are injectable so the flow is unit-testable without a real ServiceWorkerRegistration.
 */
import { reloadApp } from './reloadApp.js';

export type ForceUpdateOutcome =
  | 'updating' // a new build was found and is activating — a reload is in flight
  | 'latest' // server checked, already on the newest build — nothing to do
  | 'offline' // no network: can't check; cache keeps serving, unchanged
  | 'unsupported'; // service workers unavailable / no registration

export interface ForceUpdateDeps {
  /** Resolve the active SW registration. Defaults to navigator.serviceWorker.getRegistration(). */
  getRegistration?: () => Promise<ServiceWorkerRegistration | null | undefined>;
  /** Hard reload once the new worker takes control. Defaults to reloadApp(). */
  reload?: () => void;
  /** Online check. Defaults to navigator.onLine. */
  isOnline?: () => boolean;
}

const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;

function defaultGetRegistration(): Promise<ServiceWorkerRegistration | null | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  return navigator.serviceWorker.getRegistration();
}

function defaultIsOnline(): boolean {
  // Treat unknown as online; only a definite navigator.onLine === false is "offline".
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * The worker we should activate: one that's already waiting, or one that's still installing once it
 * reaches 'installed'. registration.update() can resolve a beat before a freshly-fetched worker
 * finishes installing, so we wait it out rather than racing reg.waiting.
 */
function pendingWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (reg.waiting) return Promise.resolve(reg.waiting);
  const installing = reg.installing;
  if (!installing) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onState = () => {
      if (installing.state === 'installed') {
        installing.removeEventListener('statechange', onState);
        resolve(reg.waiting ?? installing);
      } else if (installing.state === 'redundant') {
        installing.removeEventListener('statechange', onState);
        resolve(null);
      }
    };
    installing.addEventListener('statechange', onState);
  });
}

/** Tell a waiting worker to take over, then reload once it has activated. */
function activate(worker: ServiceWorker, reload: () => void): void {
  if (worker.state === 'activated') {
    reload();
    return;
  }
  const onState = () => {
    if (worker.state === 'activated') {
      worker.removeEventListener('statechange', onState);
      reload();
    }
  };
  worker.addEventListener('statechange', onState);
  worker.postMessage(SKIP_WAITING);
}

export async function forceUpdate(deps: ForceUpdateDeps = {}): Promise<ForceUpdateOutcome> {
  const getRegistration = deps.getRegistration ?? defaultGetRegistration;
  const reload = deps.reload ?? reloadApp;
  const isOnline = deps.isOnline ?? defaultIsOnline;

  if (!isOnline()) return 'offline';

  const reg = await getRegistration();
  if (!reg) return 'unsupported';

  try {
    // Force a fresh server check — the reliable path on iOS, which otherwise barely checks.
    await reg.update();
  } catch {
    // update() rejects when the SW script can't be fetched (offline / transient) — no-op gracefully.
    return 'offline';
  }

  const worker = await pendingWorker(reg);
  if (!worker) return 'latest';

  activate(worker, reload);
  return 'updating';
}
