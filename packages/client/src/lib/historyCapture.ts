import type { Note, NoteId } from '@deltos/shared';
import type { NoteVersion } from '../db/schema.js';
import { getStore } from '../db/store.js';
import { computeCharDelta, deltaMagnitude, noteText } from './textDelta.js';

/**
 * History CAPTURE layer (#45, spec Part B "When a version is captured" + Retention).
 *
 * A version = a COALESCED edit session, not a keystroke and not a paragraph. This layer is a SEPARATE,
 * COARSER mechanism from the 400ms autosave debounce and the 2s/5s sync push — it observes editor
 * lifecycle signals and writes a `kind:'session'` {@link NoteVersion} snapshot only on a session
 * boundary, never on a burst. It MUST NOT change save/sync cadence: capture writes its own IDB
 * transaction on `noteVersions` and is fire-and-forget from the editor's perspective.
 *
 * A `'session'` version is captured when, since the last captured version (the per-note baseline), the
 * note has MATERIALLY changed (total char delta ≥ the material floor) AND one of:
 *   (a) idle-settle — the user stopped editing for {@link CaptureThresholds.idleMs};
 *   (b) on-leave    — the user left/closed the note (also the undo→history handoff point);
 *   (c) big-change  — a single change between consecutive edit signals ≥
 *       {@link CaptureThresholds.bigChangeChars} forces an immediate mid-session checkpoint.
 *
 * The split char-delta (charsAdded/charsRemoved vs the baseline) is precomputed here and stored on the
 * row, so the timeline never recomputes diffs while scrolling (perf is a standing value). Retention
 * pruning rides the capture write (see {@link CaptureSink.captureSessionVersion}), not a timer.
 *
 * The engine is pure of IDB and of real timers: it takes an injected {@link CaptureSink}, scheduler, and
 * clock, so the capture-decision logic is unit-tested deterministically (and there is no Dexie + fake
 * timers deadlock — see the dexie-faketimers-deadlock memory).
 */

export interface CaptureThresholds {
  /** (a) idle-settle delay: capture this long after the last edit. Tunable on-device. */
  idleMs: number;
  /** (c) a single change (delta between consecutive edit signals) ≥ this forces an immediate checkpoint. */
  bigChangeChars: number;
  /** Skip captures whose total delta vs the baseline is below this — micro-edits never spawn versions. */
  materialFloorChars: number;
  /** Max retained `'session'` versions per note; the oldest beyond this are pruned at capture time. */
  retentionCap: number;
}

export const DEFAULT_CAPTURE_THRESHOLDS: CaptureThresholds = {
  idleMs: 4 * 60_000, // ~4 minutes
  bigChangeChars: 500, // a large paste / large deletion
  materialFloorChars: 24, // a few words — below this is a micro-edit
  retentionCap: 50,
};

/** The note fields the capture layer reads on each signal (a full {@link Note} satisfies this). */
export type CaptureSnapshot = Pick<Note, 'title' | 'body' | 'properties' | 'version'>;

/** A cancellable idle timer — the engine only needs to arm and cancel it. */
export interface IdleTimer {
  cancel: () => void;
}

/** The write-sink the engine depends on (the LocalStore satisfies it) — keeps the engine IDB-free. */
export interface CaptureSink {
  captureSessionVersion(version: NoteVersion, retentionCap: number): Promise<void>;
}

export interface HistoryCaptureDeps {
  sink: CaptureSink;
  thresholds?: Partial<CaptureThresholds>;
  /** Arm an idle timer; default wraps setTimeout. Tests inject a manual trigger. */
  scheduleIdle?: (cb: () => void, ms: number) => IdleTimer;
  /** ISO timestamp source; default `new Date().toISOString()`. */
  now?: () => string;
  /** Version-row id source; default `crypto.randomUUID()`. */
  newId?: () => string;
}

interface SessionState {
  noteId: NoteId;
  accountId: string;
  /** Note text at session open or at the last capture — the delta is always measured against this. */
  baselineText: string;
  /** Note text at the previous edit signal — used to size a single change for the big-change trigger. */
  lastSignalText: string;
  current: CaptureSnapshot;
  idle: IdleTimer | null;
}

const defaultScheduleIdle = (cb: () => void, ms: number): IdleTimer => {
  const h = setTimeout(cb, ms);
  return { cancel: () => clearTimeout(h) };
};

export class HistoryCapture {
  private readonly sink: CaptureSink;
  private readonly thresholds: CaptureThresholds;
  private readonly scheduleIdle: (cb: () => void, ms: number) => IdleTimer;
  private readonly now: () => string;
  private readonly newId: () => string;
  /** Keyed by noteId so overlapping route mount/unmount (open of B before leave of A) never collide. */
  private readonly sessions = new Map<NoteId, SessionState>();

  constructor(deps: HistoryCaptureDeps) {
    this.sink = deps.sink;
    this.thresholds = { ...DEFAULT_CAPTURE_THRESHOLDS, ...deps.thresholds };
    this.scheduleIdle = deps.scheduleIdle ?? defaultScheduleIdle;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Live thresholds (tunable on-device via {@link configure}). */
  getThresholds(): CaptureThresholds {
    return { ...this.thresholds };
  }

  /** Merge new threshold values at runtime (Settings knob; on-device tuning). */
  configure(partial: Partial<CaptureThresholds>): void {
    Object.assign(this.thresholds, partial);
  }

  /** Note opened: seed the per-note baseline from its current content (the pre-edit state). */
  open(noteId: NoteId, accountId: string, snap: CaptureSnapshot): void {
    const existing = this.sessions.get(noteId);
    existing?.idle?.cancel();
    const text = noteText(snap.title, snap.body);
    this.sessions.set(noteId, {
      noteId,
      accountId,
      baselineText: text,
      lastSignalText: text,
      current: snap,
      idle: null,
    });
  }

  /**
   * An edit was persisted (the already-debounced save). Re-arm idle-settle; if the single change since
   * the last signal is large, checkpoint immediately (c). Never captures on a normal burst — each edit
   * just pushes the idle deadline out. No-op if the note was never opened (defensive).
   */
  async recordEdit(noteId: NoteId, snap: CaptureSnapshot): Promise<void> {
    const s = this.sessions.get(noteId);
    if (!s) return;
    const newText = noteText(snap.title, snap.body);
    const stepMagnitude = deltaMagnitude(computeCharDelta(s.lastSignalText, newText));
    s.current = snap;
    s.lastSignalText = newText;
    s.idle?.cancel();
    s.idle = null;
    if (stepMagnitude >= this.thresholds.bigChangeChars) {
      await this.captureIfMaterial(s); // (c) big-change forces an immediate checkpoint
      return;
    }
    s.idle = this.scheduleIdle(() => void this.idleSettle(noteId), this.thresholds.idleMs);
  }

  /** (a) Idle-settle fired (or the test drives it directly): capture if materially changed. */
  async idleSettle(noteId: NoteId): Promise<void> {
    const s = this.sessions.get(noteId);
    if (!s) return;
    s.idle = null;
    await this.captureIfMaterial(s);
  }

  /** (b) Note left/closed: capture the session's final state if material, then drop the session. */
  async leave(noteId: NoteId): Promise<void> {
    const s = this.sessions.get(noteId);
    if (!s) return;
    s.idle?.cancel();
    this.sessions.delete(noteId);
    await this.captureIfMaterial(s);
  }

  /**
   * Capture a `'session'` checkpoint iff the delta vs the baseline clears the material floor. On capture,
   * advance the baseline to the snapshot just stored, so the NEXT version's delta is measured against
   * this one (the spec's "vs the previous version"). Best-effort: a sink failure never throws into the
   * editor (capture must not jank typing); the baseline is only advanced on a successful write.
   */
  private async captureIfMaterial(s: SessionState): Promise<void> {
    const text = noteText(s.current.title, s.current.body);
    const delta = computeCharDelta(s.baselineText, text);
    if (deltaMagnitude(delta) < this.thresholds.materialFloorChars) return; // not material — skip
    const row: NoteVersion = {
      id: this.newId(),
      noteId: s.noteId,
      accountId: s.accountId,
      kind: 'session',
      title: s.current.title,
      properties: s.current.properties,
      body: s.current.body,
      baseVersion: s.current.version,
      createdAt: this.now(),
      charsAdded: delta.charsAdded,
      charsRemoved: delta.charsRemoved,
    };
    try {
      await this.sink.captureSessionVersion(row, this.thresholds.retentionCap);
    } catch {
      return; // best-effort; leave the baseline unchanged so the next boundary retries the same delta
    }
    s.baselineText = text;
    s.lastSignalText = text;
  }
}

// ---------------------------------------------------------------------------
// App singleton — bound to the live LocalStore. The editor lifecycle seam (NoteRoute) drives it; tests
// construct their own HistoryCapture with a fake sink instead of touching this.
// ---------------------------------------------------------------------------
let singleton: HistoryCapture | null = null;

/** The app-wide capture engine, lazily bound to the real persistence store. */
export function getHistoryCapture(): HistoryCapture {
  if (!singleton) singleton = new HistoryCapture({ sink: getStore() });
  return singleton;
}

