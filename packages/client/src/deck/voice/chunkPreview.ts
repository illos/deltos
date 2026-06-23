/**
 * Chunked live-preview controller (#69 §6.2) — turns a stream of VAD phrase segments into a BOUNDED series
 * of transcribe calls whose results append to the greyed draft preview.
 *
 * SECURITY (navSys/secSys): the chunk loop must never fan out. This enforces SINGLE-FLIGHT + COALESCE:
 *   • At most ONE chunk transcribe call is ever in flight.
 *   • Segments that arrive while a call is in flight are CONCATENATED and sent as ONE call when it finishes
 *     — never queued as N separate calls.
 *   • A frequency cap (minIntervalMs) spaces calls out so a burst of short phrases can't rapid-fire.
 * Worst case is therefore 1 in-flight + 1 coalesced-pending, regardless of phrase rate. The injected
 * Transcriber's own single-flight (deltos adapter, gate b) is a second belt; this is the loop-level bound.
 *
 * The FINAL authoritative pass (full recording on stop) is NOT handled here — it's the existing
 * useVoiceMode path that replaces the draft and commits. deck-core, no audio APIs.
 */
import { encodeWav, concatFloat32 } from './wav.js';

export interface ChunkPreviewOptions {
  /** Minimum spacing between chunk calls (frequency cap). Default 1200ms. */
  minIntervalMs?: number;
  /** Clock seam for tests. Defaults to performance.now / Date.now. */
  now?: () => number;
}

export interface ChunkPreviewController {
  /** Submit a phrase PCM segment. Transcribed (coalesced with any pending) under the single-flight bound. */
  submit(pcm: Float32Array): void;
  /** Stop the loop: drop pending work + ignore any in-flight result. Idempotent. */
  dispose(): void;
}

export function createChunkPreviewController(
  sampleRate: number,
  transcribe: (blob: Blob) => Promise<{ transcript: string }>,
  onDraftAppend: (text: string) => void,
  opts: ChunkPreviewOptions = {},
): ChunkPreviewController {
  const minInterval = opts.minIntervalMs ?? 1200;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  let pending: Float32Array[] = [];
  let inFlight = false;
  let disposed = false;
  let lastCallStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const flush = (): void => {
    if (disposed || inFlight || pending.length === 0) return;
    const segment = concatFloat32(pending);
    pending = [];
    inFlight = true;
    lastCallStart = now();
    const blob = encodeWav(segment, sampleRate);
    transcribe(blob)
      .then(({ transcript }) => {
        if (!disposed && transcript.trim().length > 0) onDraftAppend(transcript);
      })
      .catch(() => {
        // A failed chunk is non-fatal — the draft is rough and the final pass is authoritative.
      })
      .finally(() => {
        inFlight = false;
        maybeFlush(); // drain anything that coalesced while we were in flight
      });
  };

  /** Flush now if the frequency cap allows, else schedule a flush for when it elapses. */
  function maybeFlush(): void {
    if (disposed || inFlight || pending.length === 0 || timer !== null) return;
    const elapsed = now() - lastCallStart;
    if (elapsed >= minInterval) {
      flush();
    } else {
      timer = setTimeout(() => { timer = null; maybeFlush(); }, minInterval - elapsed);
    }
  }

  return {
    submit(pcm: Float32Array): void {
      if (disposed) return;
      pending.push(pcm);
      maybeFlush();
    },
    dispose(): void {
      disposed = true;
      pending = [];
      clearTimer();
    },
  };
}
