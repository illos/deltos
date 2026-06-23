/**
 * #69 §6.2 voice live chunked preview — the pure cores: WAV encoding, the VAD phrase segmenter, and the
 * bounded single-flight+coalesce chunk-preview controller (the security-critical loop). No audio APIs.
 */
import { describe, it, expect, vi } from 'vitest';
import { encodeWav, concatFloat32 } from '../src/deck/voice/wav.js';
import { createVadSegmenter } from '../src/deck/voice/vad.js';
import { createChunkPreviewController } from '../src/deck/voice/chunkPreview.js';

const SR = 16000;
const ascii = (view: DataView, off: number, len: number) =>
  String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(off + i)));

describe('wav.encodeWav', () => {
  it('writes a valid mono 16-bit PCM WAV header + data for the samples', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(samples, SR);
    expect(blob.type).toBe('audio/wav');
    const view = new DataView(await blob.arrayBuffer());
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SR); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // data byte length
    expect(view.byteLength).toBe(44 + samples.length * 2);
    expect(view.getInt16(44, true)).toBe(0); // first sample
    expect(view.getInt16(44 + 6, true)).toBe(0x7fff); // sample value 1.0 → max positive
  });
});

describe('wav.concatFloat32', () => {
  it('concatenates buffers in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('createVadSegmenter', () => {
  const BLOCK = 1600; // 100ms blocks at 16kHz
  const block = () => new Float32Array(BLOCK);
  // tiny thresholds so block counts are predictable: 200ms hang, 200ms min phrase, 200ms pre-roll
  const opts = { voiceThreshold: 0.1, silenceHangMs: 200, minPhraseMs: 200, preRollMs: 200, maxPhraseMs: 1000 };

  it('emits ONE segment when a voiced run is followed by enough trailing silence', () => {
    const segs: Float32Array[] = [];
    const vad = createVadSegmenter(SR, (s) => segs.push(s), opts);
    // 4 voiced blocks (400ms) then 2 silent blocks (200ms = the hang) → emit
    for (let i = 0; i < 4; i++) vad.push(block(), 0.5);
    expect(segs.length).toBe(0);
    vad.push(block(), 0); // 100ms silence
    vad.push(block(), 0); // 200ms → hang reached → emit
    expect(segs.length).toBe(1);
  });

  it('DROPS a too-short phrase (below minPhrase voiced floor)', () => {
    const segs: Float32Array[] = [];
    const vad = createVadSegmenter(SR, (s) => segs.push(s), opts);
    vad.push(block(), 0.5); // only 100ms voiced (< 200ms min)
    vad.push(block(), 0);
    vad.push(block(), 0); // hang → emit attempt, but below floor → dropped
    expect(segs.length).toBe(0);
  });

  it('force-cuts a continuous phrase at maxPhrase so the draft keeps flowing', () => {
    const segs: Float32Array[] = [];
    const vad = createVadSegmenter(SR, (s) => segs.push(s), opts);
    for (let i = 0; i < 12; i++) vad.push(block(), 0.5); // 1200ms continuous > 1000ms max → at least one forced cut
    expect(segs.length).toBeGreaterThanOrEqual(1);
  });

  it('flush() emits a buffered in-progress phrase (on stop)', () => {
    const segs: Float32Array[] = [];
    const vad = createVadSegmenter(SR, (s) => segs.push(s), opts);
    for (let i = 0; i < 3; i++) vad.push(block(), 0.5); // 300ms voiced, no trailing silence
    expect(segs.length).toBe(0);
    vad.flush();
    expect(segs.length).toBe(1);
  });
});

describe('createChunkPreviewController — single-flight + coalesce (security bound)', () => {
  it('keeps at most ONE call in flight; segments arriving mid-flight COALESCE into one next call', async () => {
    let resolveFirst!: (v: { transcript: string }) => void;
    const calls: Blob[] = [];
    const transcribe = vi.fn((blob: Blob) => {
      calls.push(blob);
      if (calls.length === 1) return new Promise<{ transcript: string }>((r) => { resolveFirst = r; });
      return Promise.resolve({ transcript: 'second' });
    });
    const draft: string[] = [];
    const ctrl = createChunkPreviewController(SR, transcribe, (t) => draft.push(t), { minIntervalMs: 0 });

    ctrl.submit(new Float32Array(100)); // → fires call 1 (in flight, unresolved)
    ctrl.submit(new Float32Array(100)); // mid-flight → pending
    ctrl.submit(new Float32Array(100)); // mid-flight → pending (coalesces with the above)
    expect(transcribe).toHaveBeenCalledTimes(1); // single-flight: no 2nd call yet

    resolveFirst({ transcript: 'first' });
    await new Promise((r) => setTimeout(r, 0)); // drain the then→finally→reflush→then chain

    expect(transcribe).toHaveBeenCalledTimes(2); // exactly ONE coalesced follow-up, not two
    // the coalesced call carries both pending segments' audio (2×100 samples → 200×2 bytes + 44 header)
    expect(calls[1]!.size).toBe(44 + 200 * 2);
    expect(draft).toEqual(['first', 'second']);
    ctrl.dispose();
  });

  it('dispose() drops pending work and ignores in-flight results', async () => {
    let resolve!: (v: { transcript: string }) => void;
    const transcribe = vi.fn(() => new Promise<{ transcript: string }>((r) => { resolve = r; }));
    const draft: string[] = [];
    const ctrl = createChunkPreviewController(SR, transcribe, (t) => draft.push(t), { minIntervalMs: 0 });
    ctrl.submit(new Float32Array(100));
    ctrl.dispose();
    resolve({ transcript: 'late' });
    await Promise.resolve(); await Promise.resolve();
    expect(draft).toEqual([]); // disposed → result ignored
  });

  it('respects the frequency cap (min interval) between calls', async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const transcribe = vi.fn(async () => ({ transcript: 'x' }));
      const ctrl = createChunkPreviewController(SR, transcribe, () => {}, { minIntervalMs: 1000, now: () => clock });
      ctrl.submit(new Float32Array(10)); // t=0 → call 1
      await Promise.resolve();
      expect(transcribe).toHaveBeenCalledTimes(1);
      clock = 200;
      ctrl.submit(new Float32Array(10)); // only 200ms elapsed → scheduled, not fired
      await Promise.resolve();
      expect(transcribe).toHaveBeenCalledTimes(1);
      clock = 1000;
      vi.advanceTimersByTime(800); // reach the 1000ms cap → scheduled flush fires
      await Promise.resolve(); await Promise.resolve();
      expect(transcribe).toHaveBeenCalledTimes(2);
      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
