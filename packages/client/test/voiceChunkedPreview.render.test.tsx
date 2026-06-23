/**
 * #69 §6.2 — useVoiceMode live chunked-preview ORCHESTRATION. The recorder + PCM tap are mocked (no real
 * MediaRecorder / Web Audio in jsdom) so the test drives synthetic PCM blocks; the VAD segmenter + bounded
 * chunk controller are the REAL modules, so this exercises tap → VAD → chunk transcribe → greyed draft, and
 * the final pass replacing + clearing the draft on stop.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const fakeStream = {} as MediaStream;
const fakeBlob = new Blob(['audio'], { type: 'audio/webm' });
vi.mock('../src/deck/voice/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  createAudioRecorder: () => ({
    state: 'recording',
    stream: fakeStream, // non-null → the preview pipeline engages
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ blob: fakeBlob, mimeType: 'audio/webm', durationMs: 1000, peakLevel: 0.5 })),
    cancel: vi.fn(),
  }),
}));

// Capture the tap's onBlock so the test can emit synthetic audio (must be `mock`-prefixed for the factory).
let mockEmitBlock: ((block: Float32Array, rms: number, sampleRate: number) => void) | null = null;
vi.mock('../src/deck/voice/pcmTap.js', () => ({
  tapPcm: (_stream: MediaStream, onBlock: (b: Float32Array, rms: number, sr: number) => void) => {
    mockEmitBlock = onBlock;
    return { stop: () => { mockEmitBlock = null; } };
  },
}));

import { useVoiceMode } from '../src/deck/voice/useVoiceMode.js';

afterEach(() => { vi.clearAllMocks(); mockEmitBlock = null; });

const SR = 16000;
const block = () => new Float32Array(4096); // ~256ms at 16kHz

describe('useVoiceMode §6.2 chunked preview', () => {
  it('accumulates a greyed draft from VAD phrase chunks; the final pass commits + clears it', async () => {
    const chunkCalls: Blob[] = [];
    const chunkTranscriber = vi.fn(async (b: Blob) => { chunkCalls.push(b); return { transcript: 'hello' }; });
    const finalTranscribe = vi.fn(async () => ({ transcript: 'hello world, final.' }));
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceMode({ transcribe: finalTranscribe }, onTranscript, { chunkTranscriber }),
    );

    await act(async () => { await result.current.start(); });
    expect(mockEmitBlock).toBeTypeOf('function');

    // One phrase: 2 voiced blocks (>300ms min) then 3 silent (>600ms hang) → VAD emits a segment → chunk call.
    await act(async () => {
      mockEmitBlock!(block(), 0.5, SR);
      mockEmitBlock!(block(), 0.5, SR);
      mockEmitBlock!(block(), 0, SR);
      mockEmitBlock!(block(), 0, SR);
      mockEmitBlock!(block(), 0, SR);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(chunkTranscriber).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe('hello'); // greyed live preview accumulated

    // Stop: the live loop tears down (no last-chunk call), the FINAL pass commits + the draft clears.
    await act(async () => { await result.current.stop(); });
    expect(finalTranscribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('hello world, final.');
    expect(chunkTranscriber).toHaveBeenCalledTimes(1); // no extra chunk call fired on stop
    expect(result.current.draft).toBe(''); // draft cleared after the final pass
    expect(result.current.state).toBe('idle');
  });

  it('disabling preview (no chunkTranscriber) never taps PCM', async () => {
    const { result } = renderHook(() =>
      useVoiceMode({ transcribe: async () => ({ transcript: 'x' }) }, vi.fn()),
    );
    await act(async () => { await result.current.start(); });
    expect(mockEmitBlock).toBeNull(); // tap not engaged
    await act(async () => { await result.current.stop(); });
  });
});
