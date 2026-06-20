import { describe, it, expect, beforeEach } from 'vitest';
import type { BlockBody } from '@deltos/shared';
import type { NoteVersion } from '../src/db/schema.js';
import {
  HistoryCapture,
  type CaptureSink,
  type CaptureSnapshot,
  type IdleTimer,
} from '../src/lib/historyCapture.js';

// ---------------------------------------------------------------------------
// Test doubles: an in-memory sink (no IDB) + a manual idle scheduler (no real timers — both keep these
// tests deterministic and dodge the Dexie+fake-timers deadlock entirely).
// ---------------------------------------------------------------------------
class FakeSink implements CaptureSink {
  rows: NoteVersion[] = [];
  cap = Infinity;
  async captureSessionVersion(version: NoteVersion, retentionCap: number): Promise<void> {
    this.cap = retentionCap;
    this.rows.push(version);
  }
}

const body = (text: string): BlockBody =>
  text === '' ? [] : [{ id: 'b1', type: 'paragraph', content: { segments: [{ text }] } }];

const snap = (title: string, text: string, version = 1): CaptureSnapshot => ({
  title,
  body: body(text),
  properties: {},
  version,
});

const NOTE = 'note-1' as NoteVersion['noteId'];
const ACCT = 'acct-1';

let sink: FakeSink;
let arms: number;
let cancels: number;
let scheduleIdle: (cb: () => void, ms: number) => IdleTimer;

function makeEngine(thresholds?: Partial<ConstructorParameters<typeof HistoryCapture>[0]['thresholds']>) {
  let seq = 0;
  return new HistoryCapture({
    sink,
    thresholds: { idleMs: 1000, bigChangeChars: 100, materialFloorChars: 10, retentionCap: 50, ...thresholds },
    scheduleIdle,
    now: () => new Date(Date.UTC(2026, 5, 20, 0, 0, seq)).toISOString(),
    newId: () => `v${++seq}`,
  });
}

beforeEach(() => {
  sink = new FakeSink();
  arms = 0;
  cancels = 0;
  scheduleIdle = (_cb: () => void, _ms: number): IdleTimer => {
    arms++;
    return { cancel: () => { cancels++; } };
  };
});

describe('HistoryCapture — session boundaries, not bursts', () => {
  it('a typing burst does NOT capture; idle-settle then captures ONE coalesced version', async () => {
    const e = makeEngine();
    e.open(NOTE, ACCT, snap('Title', 'hello'));
    // burst: several edits in quick succession, none big enough to checkpoint
    await e.recordEdit(NOTE, snap('Title', 'hello world'));
    await e.recordEdit(NOTE, snap('Title', 'hello world this'));
    await e.recordEdit(NOTE, snap('Title', 'hello world this is a longer note'));
    expect(sink.rows).toHaveLength(0); // nothing captured mid-burst
    // each edit re-armed the idle timer and cancelled the prior one (so it never fires mid-burst)
    expect(arms).toBe(3);
    expect(cancels).toBe(2);

    await e.idleSettle(NOTE);
    expect(sink.rows).toHaveLength(1); // exactly ONE version for the whole burst
    expect(sink.rows[0]!.kind).toBe('session');
  });

  it('on-leave captures the final session state', async () => {
    const e = makeEngine();
    e.open(NOTE, ACCT, snap('Title', 'start'));
    await e.recordEdit(NOTE, snap('Title', 'start plus a material amount of text'));
    expect(sink.rows).toHaveLength(0);
    await e.leave(NOTE);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]!.body).toEqual(body('start plus a material amount of text'));
  });

  it('a big single change forces an immediate mid-session checkpoint', async () => {
    const e = makeEngine({ bigChangeChars: 100 });
    e.open(NOTE, ACCT, snap('Title', 'short'));
    const bigPaste = 'x'.repeat(200);
    await e.recordEdit(NOTE, snap('Title', `short ${bigPaste}`));
    expect(sink.rows).toHaveLength(1); // captured WITHOUT waiting for idle/leave
    // a big change captures and does NOT leave an armed idle timer
    expect(arms).toBe(0);
  });

  it('overlapping triggers do NOT double-write: a big-change immediately followed by leave = ONE row', async () => {
    const e = makeEngine({ bigChangeChars: 100 });
    e.open(NOTE, ACCT, snap('Title', 'short'));
    const big = snap('Title', `short ${'x'.repeat(200)}`);
    // Kick the big-change capture and the leave WITHOUT awaiting the first — they race onto the serial
    // tail. The leave must see the baseline already advanced and skip, not re-capture the same content.
    const p = e.recordEdit(NOTE, big);
    await e.leave(NOTE);
    await p;
    expect(sink.rows).toHaveLength(1); // exactly one, not two
  });

  it('a pending idle capture racing with leave also collapses to ONE row', async () => {
    const e = makeEngine();
    e.open(NOTE, ACCT, snap('Title', 'base text here'));
    await e.recordEdit(NOTE, snap('Title', 'base text here plus a material change'));
    // idle-settle and leave fire nearly together (timer fires as the route tears down)
    const idle = e.idleSettle(NOTE);
    await e.leave(NOTE);
    await idle;
    expect(sink.rows).toHaveLength(1);
  });
});

describe('HistoryCapture — material-change floor', () => {
  it('a trivial micro-edit below the floor does NOT spawn a version (on idle OR leave)', async () => {
    const e = makeEngine({ materialFloorChars: 10 });
    e.open(NOTE, ACCT, snap('Title', 'hello world'));
    await e.recordEdit(NOTE, snap('Title', 'hello world!')); // +1 char — below floor
    await e.idleSettle(NOTE);
    expect(sink.rows).toHaveLength(0);
    await e.recordEdit(NOTE, snap('Title', 'hello world!!')); // still tiny
    await e.leave(NOTE);
    expect(sink.rows).toHaveLength(0);
  });

  it('a change at/above the floor DOES capture', async () => {
    const e = makeEngine({ materialFloorChars: 10 });
    e.open(NOTE, ACCT, snap('Title', 'hello'));
    await e.recordEdit(NOTE, snap('Title', 'hello, here is a real edit'));
    await e.idleSettle(NOTE);
    expect(sink.rows).toHaveLength(1);
  });
});

describe('HistoryCapture — precomputed split delta + baseline advance', () => {
  it('stores charsAdded/charsRemoved (split, not net) vs the baseline', async () => {
    const e = makeEngine();
    e.open(NOTE, ACCT, snap('Title', 'the cat sat on the mat'));
    await e.recordEdit(NOTE, snap('Title', 'the dog sat on the rug')); // cat→dog, mat→rug
    await e.leave(NOTE);
    expect(sink.rows).toHaveLength(1);
    const row = sink.rows[0]!;
    // "...cat sat on the mat" → "...dog sat on the rug": two contiguous 3-char replaces
    expect(row.charsAdded).toBeGreaterThan(0);
    expect(row.charsRemoved).toBeGreaterThan(0);
    expect(row.charsAdded).toBe(row.charsRemoved); // equal-length replaces — split, not netted to 0
  });

  it('after a capture the baseline advances: the NEXT version measures vs the previous one', async () => {
    const e = makeEngine({ idleMs: 1000, materialFloorChars: 5 });
    e.open(NOTE, ACCT, snap('Title', 'AAAA'));
    await e.recordEdit(NOTE, snap('Title', 'AAAA BBBBB')); // +6 vs baseline
    await e.idleSettle(NOTE); // capture v1 (delta vs 'AAAA')
    await e.recordEdit(NOTE, snap('Title', 'AAAA BBBBB CCCCC')); // +6 vs v1, NOT +12 vs original
    await e.idleSettle(NOTE); // capture v2 (delta vs v1's snapshot)
    expect(sink.rows).toHaveLength(2);
    expect(sink.rows[1]!.charsAdded).toBe(6); // measured against the previous version, not the open baseline
    expect(sink.rows[1]!.charsRemoved).toBe(0);
  });

  it('captures are account-scoped + carry the note id and current version', async () => {
    const e = makeEngine();
    e.open(NOTE, ACCT, snap('Title', 'before', 7));
    await e.leave(NOTE); // no material change → nothing
    expect(sink.rows).toHaveLength(0);
    e.open(NOTE, ACCT, snap('Title', 'before', 7));
    await e.recordEdit(NOTE, snap('Title', 'before — now with material new content', 7));
    await e.leave(NOTE);
    const row = sink.rows[0]!;
    expect(row.noteId).toBe(NOTE);
    expect(row.accountId).toBe(ACCT);
    expect(row.baseVersion).toBe(7);
    expect(sink.cap).toBe(50); // retention cap threaded to the sink
  });
});

describe('HistoryCapture — guards', () => {
  it('recordEdit / idleSettle / leave before open() are no-ops (no session)', async () => {
    const e = makeEngine();
    await e.recordEdit(NOTE, snap('Title', 'orphan edit'));
    await e.idleSettle(NOTE);
    await e.leave(NOTE);
    expect(sink.rows).toHaveLength(0);
  });

  it('a sink failure does not throw into the caller and leaves the baseline so the next boundary retries', async () => {
    const e = makeEngine();
    sink.captureSessionVersion = async () => { throw new Error('idb down'); };
    e.open(NOTE, ACCT, snap('Title', 'base'));
    await e.recordEdit(NOTE, snap('Title', 'base with a real material change here'));
    await expect(e.leave(NOTE)).resolves.toBeUndefined(); // swallowed
  });
});
