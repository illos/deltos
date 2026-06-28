/**
 * forceUpdate — manual PWA "Update now" flow (pwa-force-update).
 *
 * FU-1  online + a WAITING build → update() called, SKIP_WAITING posted, 'updating'; reload fires on activate
 * FU-2  online + no waiting/installing build → update() called, 'latest', no SKIP_WAITING, no reload
 * FU-3  offline (navigator.onLine === false) → 'offline', registration never touched
 * FU-4  update() rejects (transient/offline) → 'offline', no reload
 * FU-5  no registration (SW unsupported) → 'unsupported'
 * FU-6  an INSTALLING build that finishes installing → activated + reload (waits out the install)
 *
 * Deps are injected, so no real ServiceWorkerRegistration / navigator is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { forceUpdate } from '../src/lib/forceUpdate.js';

class FakeWorker {
  state: ServiceWorker['state'];
  postMessage = vi.fn();
  private listeners: Array<() => void> = [];
  constructor(state: ServiceWorker['state']) {
    this.state = state;
  }
  addEventListener(_type: 'statechange', cb: () => void) {
    this.listeners.push(cb);
  }
  removeEventListener(_type: 'statechange', cb: () => void) {
    this.listeners = this.listeners.filter((f) => f !== cb);
  }
  /** Flip state and fire statechange, like the real SW lifecycle. */
  flip(state: ServiceWorker['state']) {
    this.state = state;
    for (const cb of [...this.listeners]) cb();
  }
}

function makeReg(opts: { waiting?: FakeWorker; installing?: FakeWorker; updateRejects?: boolean }) {
  const update = vi.fn(async () => {
    if (opts.updateRejects) throw new Error('fetch failed');
  });
  return {
    reg: {
      update,
      waiting: opts.waiting ?? null,
      installing: opts.installing ?? null,
    } as unknown as ServiceWorkerRegistration,
    update,
  };
}

describe('FU-1 — online + waiting build → activates on demand and reloads', () => {
  it('calls update(), posts SKIP_WAITING, returns updating, reloads once activated', async () => {
    const waiting = new FakeWorker('installed');
    const { reg, update } = makeReg({ waiting });
    const reload = vi.fn();

    const outcome = await forceUpdate({
      getRegistration: async () => reg,
      reload,
      isOnline: () => true,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(outcome).toBe('updating');
    expect(reload).not.toHaveBeenCalled(); // not until the worker activates

    waiting.flip('activating');
    expect(reload).not.toHaveBeenCalled();
    waiting.flip('activated');
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('FU-2 — online + no pending build → already latest', () => {
  it('calls update(), returns latest, no SKIP_WAITING, no reload', async () => {
    const { reg, update } = makeReg({});
    const reload = vi.fn();

    const outcome = await forceUpdate({
      getRegistration: async () => reg,
      reload,
      isOnline: () => true,
    });

    expect(update).toHaveBeenCalledOnce();
    expect(outcome).toBe('latest');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('FU-3 — offline → no-op', () => {
  it('returns offline and never touches the registration', async () => {
    const getRegistration = vi.fn(async () => null);
    const reload = vi.fn();

    const outcome = await forceUpdate({
      getRegistration,
      reload,
      isOnline: () => false,
    });

    expect(outcome).toBe('offline');
    expect(getRegistration).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('FU-4 — update() rejects → offline', () => {
  it('returns offline and does not reload', async () => {
    const { reg } = makeReg({ updateRejects: true });
    const reload = vi.fn();

    const outcome = await forceUpdate({
      getRegistration: async () => reg,
      reload,
      isOnline: () => true,
    });

    expect(outcome).toBe('offline');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('FU-5 — no registration → unsupported', () => {
  it('returns unsupported', async () => {
    const outcome = await forceUpdate({
      getRegistration: async () => null,
      reload: vi.fn(),
      isOnline: () => true,
    });
    expect(outcome).toBe('unsupported');
  });
});

describe('FU-6 — installing build finishes → activates and reloads', () => {
  it('waits out the install, then activates and reloads', async () => {
    const installing = new FakeWorker('installing');
    const { reg } = makeReg({ installing });
    const reload = vi.fn();

    const outcomeP = forceUpdate({
      getRegistration: async () => reg,
      reload,
      isOnline: () => true,
    });

    // Let update() resolve and pendingWorker attach its statechange listener.
    await Promise.resolve();
    await Promise.resolve();
    // Worker finishes installing → becomes the waiting worker.
    (reg as unknown as { waiting: FakeWorker }).waiting = installing;
    installing.flip('installed');

    const outcome = await outcomeP;
    expect(outcome).toBe('updating');
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    installing.flip('activated');
    expect(reload).toHaveBeenCalledOnce();
  });
});
