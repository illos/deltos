import { transcribe } from '../lib/voiceTranscribe.js';
import type { Transcriber } from '../deck/index.js';

/**
 * deltos's concrete Transcriber (#69 §6.1b) — implements the Deck's Transcriber interface by POSTing to
 * /api/transcribe (Cloudflare Workers AI Whisper, with the deltos bearer) via voiceTranscribe. Injected
 * into the Deck voice loadout; the Deck never knows it's Whisper.
 *
 * SECURITY GATE (b): CLIENT SINGLE-FLIGHT + a minimum inter-call interval at the layer that makes the
 * actual paid call — ONE transcribe in flight at a time (a concurrent call coalesces onto it), and a too-
 * soon repeat is refused (empty transcript = no-op). So a UI bug / rapid mic taps can't loop the paid
 * endpoint, regardless of how the capability calls it (survives the §6.2 chunked path too).
 */
const MIN_INTERVAL_MS = 1000;

export function createDeltosTranscriber(): Transcriber {
  let inFlight: Promise<{ transcript: string }> | null = null;
  let lastStartedAt = 0;

  return {
    transcribe(blob: Blob): Promise<{ transcript: string }> {
      if (inFlight) return inFlight; // single-flight: coalesce a concurrent call onto the active one
      const now = Date.now();
      if (now - lastStartedAt < MIN_INTERVAL_MS) {
        return Promise.resolve({ transcript: '' }); // too soon — debounce a rapid repeat into a no-op
      }
      lastStartedAt = now;
      inFlight = transcribe(blob)
        .then((r) => ({ transcript: r.transcript }))
        .finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
