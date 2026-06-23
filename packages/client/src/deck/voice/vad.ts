/**
 * Voice-activity segmenter (#69 §6.2) — slices a stream of PCM blocks into per-PHRASE segments by audio
 * energy, so the live-preview chunker cuts BETWEEN phrases (at silence gaps) rather than mid-word.
 *
 * It's a pure state machine: you feed it fixed-size PCM blocks plus each block's RMS (0..1); it buffers
 * voiced audio and, when a voiced run is followed by enough trailing silence, emits the buffered phrase as
 * one Float32 PCM segment (the caller WAV-encodes + transcribes it). Time is measured in SAMPLES (derived
 * from the block lengths + sampleRate), never wall-clock — so it's deterministic and unit-testable. This is
 * the richer sibling of the shipped silence-gate primitive (audioCapture peakLevel); both key off energy.
 *
 * deck-core, zero deps. The browser-audio side (AudioContext → PCM blocks) lives in ./pcmTap.ts.
 */

export interface VadOptions {
  /** RMS at/above which a block counts as voiced. Default 0.015 (just above room tone, below speech). */
  voiceThreshold?: number;
  /** Trailing silence that ends a phrase. Default 600ms (a natural between-sentence pause). */
  silenceHangMs?: number;
  /** Discard phrases with less than this much VOICED audio (clicks, stray noise). Default 300ms. */
  minPhraseMs?: number;
  /** Force-emit a still-going phrase after this long so the draft keeps flowing in continuous speech. Default 8000ms. */
  maxPhraseMs?: number;
  /** Audio retained BEFORE voice onset, prepended so the first phoneme isn't clipped. Default 200ms. */
  preRollMs?: number;
}

export interface VadSegmenter {
  /** Feed one PCM block and its RMS. The block is retained by reference — pass a copy if you reuse buffers. */
  push(block: Float32Array, rms: number): void;
  /** Emit any buffered phrase immediately (call on stop). No-op if nothing voiced is buffered. */
  flush(): void;
}

const msToSamples = (ms: number, sampleRate: number): number => Math.round((ms / 1000) * sampleRate);

/**
 * Create a phrase segmenter. `onSegment` receives one self-contained Float32 PCM segment per detected
 * phrase (in capture order); WAV-encode + transcribe it. Segments below `minPhraseMs` of voiced audio are
 * silently dropped.
 */
export function createVadSegmenter(
  sampleRate: number,
  onSegment: (pcm: Float32Array) => void,
  opts: VadOptions = {},
): VadSegmenter {
  const voiceThreshold = opts.voiceThreshold ?? 0.015;
  const silenceHang = msToSamples(opts.silenceHangMs ?? 600, sampleRate);
  const minPhrase = msToSamples(opts.minPhraseMs ?? 300, sampleRate);
  const maxPhrase = msToSamples(opts.maxPhraseMs ?? 8000, sampleRate);
  const preRollCap = msToSamples(opts.preRollMs ?? 200, sampleRate);

  let inPhrase = false;
  let buffered: Float32Array[] = []; // current phrase audio
  let phraseSamples = 0; // total samples in current phrase
  let voicedSamples = 0; // voiced samples in current phrase (gates minPhrase)
  let silenceRun = 0; // trailing silence samples while in a phrase

  // Ring of recent blocks while idle, prepended on voice onset so word-starts aren't clipped.
  let preRoll: Float32Array[] = [];
  let preRollSamples = 0;

  const concat = (parts: readonly Float32Array[]): Float32Array => {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };

  const reset = (): void => {
    inPhrase = false;
    buffered = [];
    phraseSamples = 0;
    voicedSamples = 0;
    silenceRun = 0;
  };

  /** Emit the buffered phrase if it cleared the minimum voiced floor, then reset to idle. */
  const emit = (): void => {
    if (voicedSamples >= minPhrase && buffered.length > 0) onSegment(concat(buffered));
    reset();
  };

  return {
    push(block: Float32Array, rms: number): void {
      const voiced = rms >= voiceThreshold;

      if (!inPhrase) {
        if (voiced) {
          // Voice onset: seed the phrase with the pre-roll + this block.
          buffered = [...preRoll, block];
          phraseSamples = preRollSamples + block.length;
          voicedSamples = block.length;
          silenceRun = 0;
          inPhrase = true;
          preRoll = [];
          preRollSamples = 0;
        } else {
          // Idle silence: keep a bounded pre-roll ring.
          preRoll.push(block);
          preRollSamples += block.length;
          while (preRollSamples > preRollCap && preRoll.length > 1) {
            preRollSamples -= preRoll.shift()!.length;
          }
        }
        return;
      }

      // In a phrase: accumulate, track voiced/silence.
      buffered.push(block);
      phraseSamples += block.length;
      if (voiced) {
        voicedSamples += block.length;
        silenceRun = 0;
      } else {
        silenceRun += block.length;
      }

      if (silenceRun >= silenceHang) {
        emit(); // phrase ended on a silence gap
      } else if (phraseSamples >= maxPhrase) {
        // Continuous speech with no gap: cut here so the draft keeps flowing, stay in-phrase.
        if (voicedSamples >= minPhrase) onSegment(concat(buffered));
        buffered = [];
        phraseSamples = 0;
        voicedSamples = 0;
        silenceRun = 0;
      }
    },

    flush(): void {
      if (inPhrase) emit();
    },
  };
}
