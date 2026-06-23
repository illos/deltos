import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAudioRecorder, isAudioCaptureSupported } from '../src/lib/audioCapture.js';

/**
 * Voice CAPTURE stage tests (custom-keyboard spec §6, stage 1). The recorder is note-agnostic plumbing
 * over MediaRecorder; jsdom/node has neither MediaRecorder nor getUserMedia, so we stub both globals and
 * assert the lifecycle: acquire mic on start, yield a blob on stop, release the mic tracks on stop/cancel.
 */

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}

/** Install fake MediaRecorder + navigator.mediaDevices globals. Returns handles to assert against. */
function installMediaStubs(opts: { supportedTypes?: string[] } = {}) {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  const getUserMedia = vi.fn(() => Promise.resolve(stream as unknown as MediaStream));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

  const supported = opts.supportedTypes ?? ['audio/webm;codecs=opus', 'audio/webm'];
  class FakeMediaRecorder {
    static isTypeSupported = (t: string) => supported.includes(t);
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    readonly mimeType: string;
    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? '';
    }
    start() {
      /* recording — chunks are delivered at stop in this stub */
    }
    stop() {
      // Deliver one data chunk, then fire onstop (mirrors a real single-chunk recording).
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType || 'audio/webm' }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  return { tracks, getUserMedia };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('audioCapture — note-agnostic mic recorder', () => {
  it('isAudioCaptureSupported() is true with the APIs present, false without', () => {
    installMediaStubs();
    expect(isAudioCaptureSupported()).toBe(true);
    vi.stubGlobal('MediaRecorder', undefined);
    expect(isAudioCaptureSupported()).toBe(false);
  });

  it('start → stop yields an audio blob with mimeType + duration, then releases the mic', async () => {
    const { tracks, getUserMedia } = installMediaStubs();
    const rec = createAudioRecorder();
    expect(rec.state).toBe('idle');

    await rec.start();
    expect(rec.state).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });

    const recording = await rec.stop();
    expect(rec.state).toBe('stopped');
    expect(recording.blob).toBeInstanceOf(Blob);
    expect(recording.blob.size).toBeGreaterThan(0);
    expect(recording.mimeType).toBe('audio/webm;codecs=opus'); // first supported preferred type
    expect(typeof recording.durationMs).toBe('number');
    // mic released — every track stopped so the OS recording indicator clears.
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('cancel() releases the mic without producing a recording', async () => {
    const { tracks } = installMediaStubs();
    const rec = createAudioRecorder();
    await rec.start();
    rec.cancel();
    expect(rec.state).toBe('idle');
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('falls back to the browser default mimeType when none of the preferred types are supported', async () => {
    installMediaStubs({ supportedTypes: [] });
    const rec = createAudioRecorder();
    await rec.start();
    const recording = await rec.stop();
    // No mimeType passed to the recorder → blob falls back to the chunk type (audio/webm here).
    expect(recording.blob).toBeInstanceOf(Blob);
  });

  it('start() rejects when capture is unsupported', async () => {
    installMediaStubs();
    vi.stubGlobal('MediaRecorder', undefined);
    const rec = createAudioRecorder();
    await expect(rec.start()).rejects.toThrow(/not supported/);
  });

  it('stop() rejects when not recording', async () => {
    installMediaStubs();
    const rec = createAudioRecorder();
    await expect(rec.stop()).rejects.toThrow(/not recording/);
  });
});
