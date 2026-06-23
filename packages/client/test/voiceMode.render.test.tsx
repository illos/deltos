/**
 * #69 §6.1b — the Deck voice-mode state machine + the Transcriber-interface seam. The recorder is mocked
 * (no real MediaRecorder/getUserMedia in jsdom); the Transcriber is a mock, proving the Deck calls the
 * injected interface and routes the transcript out without knowing the backend.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const fakeBlob = new Blob(['audio'], { type: 'audio/webm' });
vi.mock('../src/deck/voice/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  createAudioRecorder: () => ({
    state: 'recording',
    stream: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ blob: fakeBlob, mimeType: 'audio/webm', durationMs: 100 })),
    cancel: vi.fn(),
  }),
}));

import { useVoiceMode } from '../src/deck/voice/useVoiceMode.js';

afterEach(() => vi.clearAllMocks());

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

  it('start() is a no-op unless idle (no double-record)', async () => {
    const { result } = renderHook(() => useVoiceMode({ transcribe: async () => ({ transcript: 'x' }) }, vi.fn()));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.start(); }); // second start ignored
    expect(result.current.state).toBe('recording');
  });
});
