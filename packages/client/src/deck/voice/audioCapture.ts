/**
 * Audio CAPTURE (#69 §6 stage 1, relocated into Deck-core per §6.1b) — a note-agnostic microphone recorder.
 *
 * Generic browser MediaRecorder wrapper with ZERO deltos/editor coupling, so it belongs in the extractable
 * Deck (the voice loadout's capture half). It wraps MediaRecorder into a tiny start/stop API that yields an
 * audio Blob — the raw first-class artifact. The Deck's voice loadout records with it and hands the blob to
 * the injected Transcriber; a future voice-memo consumer keeps the same blob to persist audio.
 */

/** The recorded audio + the metadata a consumer needs to persist or transcribe it. */
export interface AudioRecording {
  /** The captured audio. Container/codec is platform-chosen (see {@link AudioRecorder.mimeType}). */
  blob: Blob;
  /** The actual MIME type the platform recorded (e.g. `audio/webm;codecs=opus`, `audio/mp4`). */
  mimeType: string;
  /** Wall-clock recording duration in milliseconds (best-effort, from start→stop). */
  durationMs: number;
}

export type RecorderState = 'idle' | 'recording' | 'stopped';

export interface AudioRecorder {
  /** Acquire the mic and begin recording. Rejects if permission is denied or capture is unsupported. */
  start(): Promise<void>;
  /** Stop recording and resolve the captured audio. Rejects if not currently recording. */
  stop(): Promise<AudioRecording>;
  /** Abort recording and release the mic without producing a recording (e.g. user cancels). */
  cancel(): void;
  /** The live MediaStream while recording (for a Web Audio AnalyserNode → waveform), else null. */
  readonly stream: MediaStream | null;
  /** Current lifecycle state. */
  readonly state: RecorderState;
}

/**
 * Candidate containers in preference order. Whisper auto-detects the container, so we just take the first
 * the platform supports: Opus-in-WebM (Chromium/Firefox/Android) or MP4/AAC (Safari/iOS). An empty string
 * lets the browser pick its own default if none match (older engines).
 */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg;codecs=opus',
];

/** Whether this environment can capture microphone audio at all (feature-detect before offering a trigger). */
export function isAudioCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** Pick the first preferred MIME type the platform's MediaRecorder can actually produce. */
function chooseMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return PREFERRED_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/**
 * Create a microphone recorder. Each recorder is single-use per recording cycle but reusable across
 * cycles (start → stop → start again). The mic stream is acquired on {@link AudioRecorder.start} and
 * released on stop/cancel, so the OS mic indicator only shows while actually recording.
 */
export function createAudioRecorder(): AudioRecorder {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let state: RecorderState = 'idle';
  let startedAt = 0;

  /** Stop all mic tracks so the OS releases the microphone (and clears the recording indicator). */
  function releaseStream(): void {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  return {
    get state() {
      return state;
    },
    get stream() {
      return stream;
    },

    async start(): Promise<void> {
      if (state === 'recording') throw new Error('already recording');
      if (!isAudioCaptureSupported()) throw new Error('audio capture is not supported in this environment');

      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.start();
      startedAt = performance.now();
      state = 'recording';
    },

    stop(): Promise<AudioRecording> {
      return new Promise<AudioRecording>((resolve, reject) => {
        const rec = recorder;
        if (state !== 'recording' || !rec) {
          reject(new Error('not recording'));
          return;
        }
        rec.onstop = () => {
          const durationMs = Math.round(performance.now() - startedAt);
          // The recorder's mimeType is the source of truth for the produced container; fall back to the
          // first chunk's type if the platform left it blank.
          const mimeType = rec.mimeType || chunks[0]?.type || 'audio/webm';
          const blob = new Blob(chunks, { type: mimeType });
          releaseStream();
          recorder = null;
          chunks = [];
          state = 'stopped';
          resolve({ blob, mimeType, durationMs });
        };
        rec.stop();
      });
    },

    cancel(): void {
      if (recorder && state === 'recording') {
        // Drop the onstop handler so no recording is produced, then stop the recorder + release the mic.
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // Already inactive — nothing to do.
        }
      }
      releaseStream();
      recorder = null;
      chunks = [];
      state = 'idle';
    },
  };
}
