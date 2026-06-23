/**
 * #69 §6.1 gate (b) — the deltos concrete Transcriber's CLIENT single-flight + min inter-call interval, so
 * a UI bug / rapid mic taps can't loop the paid /api/transcribe endpoint. voiceTranscribe is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/voiceTranscribe.js', () => ({ transcribe: vi.fn() }));
import { transcribe as rawTranscribe } from '../src/lib/voiceTranscribe.js';
import { createDeltosTranscriber } from '../src/editor/voiceTranscriber.js';

const mockRaw = rawTranscribe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockRaw.mockReset());

describe('createDeltosTranscriber — single-flight + min interval (gate b)', () => {
  it('coalesces a concurrent call onto the in-flight one (ONE paid call)', async () => {
    let resolve!: (v: { transcript: string }) => void;
    mockRaw.mockReturnValue(new Promise((r) => { resolve = r; }));
    const t = createDeltosTranscriber();
    const blob = new Blob(['a']);
    const p1 = t.transcribe(blob);
    const p2 = t.transcribe(blob); // concurrent → must NOT make a second call
    expect(mockRaw).toHaveBeenCalledTimes(1);
    resolve({ transcript: 'x' });
    expect(await p1).toEqual({ transcript: 'x' });
    expect(await p2).toEqual({ transcript: 'x' }); // coalesced onto the same result
  });

  it('refuses a too-soon repeat (min interval) → empty transcript, no extra call', async () => {
    mockRaw.mockResolvedValue({ transcript: 'one' });
    const t = createDeltosTranscriber();
    const blob = new Blob(['a']);
    expect(await t.transcribe(blob)).toEqual({ transcript: 'one' });
    expect(await t.transcribe(blob)).toEqual({ transcript: '' }); // < min interval → debounced no-op
    expect(mockRaw).toHaveBeenCalledTimes(1);
  });
});
