import { useEffect, useRef, useState } from 'react';
import { getSyncState, subscribeSyncState, flushPushQueue } from '../lib/syncEngine.js';
import type { SyncIndicatorState } from '../lib/syncEngine.js';
import { flushPendingEdits } from '../lib/pendingEditFlush.js';
import { reloadApp } from '../lib/reloadApp.js';
import { useSyncQueueCount } from '../db/storeHooks.js';
import { useAuthStore } from '../auth/store.js';
import './SyncIndicator.css';

type EffectiveState = SyncIndicatorState | 'local-only';

/**
 * #101 — the blip kind drives the colour + the pulse. The engine's five states (+ local-only) collapse
 * onto four blips: a single COLOR per signal, no text. (Jim's locked mapping.)
 *   solid green   — synced (a real round-trip completed)
 *   pulsing green — work in flight OR queued (syncing/pending folded together: "not fully synced yet")
 *   yellow        — error ONLY
 *   grey/dim      — offline OR local-only ("not syncing right now", NOT an error — #85/#86 keep these
 *                   distinct from error so an offline device never shows a scary yellow).
 */
type Blip = 'synced' | 'syncing' | 'error' | 'offline';

const BLIP: Record<EffectiveState, Blip> = {
  idle:         'synced',  // reached only with an active session (idle + no session → 'local-only' below)
  syncing:      'syncing', // pulsing — pushing/pulling
  pending:      'syncing', // pulsing — queued writes folded into the same "not fully synced yet" pulse
  error:        'error',   // yellow — error ONLY
  offline:      'offline', // grey/dim — no connectivity, not an error
  'local-only': 'offline', // grey/dim — never synced this session (signed out)
};

/** Tooltip (hover + aria) — the descriptive signal the visible text used to carry. */
const STATE_TITLE: Record<EffectiveState, string> = {
  idle:         'All changes synced',
  syncing:      'Syncing with server…',
  pending:      'Changes queued to sync',
  offline:      'Offline — changes saved locally',
  error:        'Last sync failed — will retry',
  'local-only': 'Notes saved locally — sign in to sync',
};

/**
 * Shell sync status — a pure colored BLIP (no visible text label; the tooltip + aria-label carry the
 * words). Renders in the mobile shell bar and the desktop note-meta row; one component, same everywhere.
 *
 * The blip is a button: tapping it is the manual "kick it" escape hatch — flush any in-flight work to
 * Dexie/the server, THEN hard-reload to clear a stuck error. Harmless when already synced. Data-safe: the
 * in-memory editor edit is committed (awaited) before the reload (#101).
 */
export function SyncIndicator() {
  const [state, setState] = useState<SyncIndicatorState>(getSyncState);
  const queueCount = useSyncQueueCount();
  const sessionState = useAuthStore((s) => s.sessionState);
  const reloadingRef = useRef(false);

  useEffect(() => subscribeSyncState(setState), []);

  // Engine 'idle' means "no pending work" — only trustworthy as "synced" when a session is active and a
  // real round-trip completed. Without an active session, idle means sync never ran → 'local-only' (grey),
  // so the blip is never misleadingly green when data hasn't reached the server.
  const effectiveState: EffectiveState =
    state === 'idle' && sessionState !== 'active' ? 'local-only' : state;

  const blip = BLIP[effectiveState];

  // #105 sonar-ping ring: the core dot stays SOLID green (no dimming pulse — that read as a glitch at ~1s
  // sync cycles). Syncing/pending emit a slow expanding ring instead. Keep the ring MOUNTED while syncing;
  // when syncing ends, let the in-flight ping FINISH its current expansion (graceful, no abrupt cut) then
  // unmount on the next animation iteration. stopAfterIterationRef carries the "stop at the next boundary"
  // intent without re-rendering.
  const isSyncing = blip === 'syncing';
  const [ringMounted, setRingMounted] = useState(false);
  const stopAfterIterationRef = useRef(false);
  useEffect(() => {
    if (isSyncing) {
      stopAfterIterationRef.current = false;
      setRingMounted(true);
    } else if (ringMounted) {
      stopAfterIterationRef.current = true; // finish the current ping, then stop (handled on iteration)
    }
  }, [isSyncing, ringMounted]);

  // Keep the pending count in the tooltip (cheap) even though the visible N-count is gone.
  const baseTitle =
    effectiveState === 'pending' && queueCount > 0
      ? `${queueCount} change${queueCount === 1 ? '' : 's'} queued to sync`
      : STATE_TITLE[effectiveState];
  const title = `${baseTitle} · Tap to reload`;

  // Tap = flush-then-hard-reload. (1) commit the editor's in-memory debounced edit to Dexie and AWAIT it
  // (IndexedDB aborts mid-write on unload), (2) push the durable queue to the server best-effort (clears a
  // stuck error), (3) hard reload. Reload regardless of flush errors — the durable Dexie queue re-pushes on
  // next load, so the worst case is a delayed push, never a lost edit.
  const handleReload = async () => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    try {
      await flushPendingEdits();
      await flushPushQueue();
    } catch {
      // best-effort — fall through to the reload
    }
    reloadApp();
  };

  return (
    <button
      type="button"
      className={`sync-indicator sync-indicator--${blip}`}
      title={title}
      aria-live="polite"
      aria-label={`Sync status: ${STATE_TITLE[effectiveState]}. Tap to reload.`}
      // Swallow focus-steal like the Deck backplane: keep the editor focused so its debounce stays pending
      // and the flush above can commit+await it (a blur-driven save is fire-and-forget → unload race).
      onPointerDown={(e) => e.preventDefault()}
      onClick={handleReload}
    >
      <span className="sync-indicator__dot" aria-hidden="true" />
      {ringMounted && (
        <span
          className="sync-indicator__ring"
          aria-hidden="true"
          // Each iteration = one completed ping. If syncing has ended, unmount HERE so the just-finished
          // ping was shown in full (graceful) rather than cut mid-expansion.
          onAnimationIteration={() => {
            if (stopAfterIterationRef.current) setRingMounted(false);
          }}
        />
      )}
    </button>
  );
}
