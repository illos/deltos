/**
 * #69 §6.1b — the Deck voice-mode state machine + the Transcriber-interface seam. The recorder is mocked
 * (no real MediaRecorder/getUserMedia in jsdom); the Transcriber is a mock, proving the Deck calls the
 * injected interface and routes the transcript out without knowing the backend.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const fakeBlob = new Blob(['audio'], { type: 'audio/webm' });
// Per-test mic energy: default = clear speech. A test lowers it below SILENCE_PEAK_THRESHOLD to exercise the
// silence gate. (Must be `mock`-prefixed to be referenced inside the hoisted vi.mock factory.)
let mockPeakLevel = 0.5;
vi.mock('../src/deck/voice/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  createAudioRecorder: () => ({
    state: 'recording',
    stream: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ blob: fakeBlob, mimeType: 'audio/webm', durationMs: 100, peakLevel: mockPeakLevel })),
    cancel: vi.fn(),
  }),
}));

import { useVoiceMode } from '../src/deck/voice/useVoiceMode.js';

afterEach(() => { vi.clearAllMocks(); mockPeakLevel = 0.5; });

describe('useVoiceMode — state machine + Transcriber seam', () => {
  it('idle → recording → transcribing → idle; the injected Transcriber gets the blob, transcript → onTranscript', async () => {
    const transcribe = vi.fn(async () => ({ transcript: 'hello world' }));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceMode({ transcribe }, onTranscript));

    expect(result.current.state).toBe('idle');
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe('recording');
    await act(async () => { await result.current.stop(); });

    expect(transcribe).toHaveBeenCalledWith(fakeBlob);
    expect(onTranscript).toHaveBeenCalledWith('hello world');
    expect(result.current.state).toBe('idle');
  });

  it('an empty/whitespace transcript is NOT committed', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceMode({ transcribe: async () => ({ transcript: '   ' }) }, onTranscript));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('an effectively-SILENT clip (peak energy below threshold) skips transcription entirely — inserts nothing', async () => {
    mockPeakLevel = 0.005; // below SILENCE_PEAK_THRESHOLD (0.01) → no-speech → no Whisper call (anti-hallucination)
    const transcribe = vi.fn(async () => ({ transcript: 'Thank you' })); // what Whisper would hallucinate on silence
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceMode({ transcribe }, onTranscript));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('start() is a no-op unless idle (no double-record)', async () => {
    const { result } = renderHook(() => useVoiceMode({ transcribe: async () => ({ transcript: 'x' }) }, vi.fn()));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.start(); }); // second start ignored
    expect(result.current.state).toBe('recording');
  });
});
