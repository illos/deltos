/**
 * PCM tap (#69 §6.2) — the thin browser-audio shell that feeds the live-preview VAD. It taps a live mic
 * MediaStream with a Web Audio graph and calls `onBlock` with each PCM block + its RMS + the sample rate.
 *
 * This is the ONLY audio-API surface of the chunked-preview pipeline; the segmentation (./vad.ts), WAV
 * encoding (./wav.ts), and bounded transcribe loop (./chunkPreview.ts) are pure + unit-tested. Kept
 * deliberately minimal and fail-safe: if Web Audio is unavailable or setup throws, it returns an inert tap
 * (the preview simply doesn't run; the authoritative final pass on stop is unaffected).
 *
 * Uses a ScriptProcessorNode (deprecated but universally supported, incl. iOS Safari) routed through a
 * MUTED gain node to the destination — the sink keeps onaudioprocess firing without playing the mic back.
 */

export interface PcmTap {
  stop(): void;
}

/** A 4096-sample block ≈ 256ms at 16kHz / ~93ms at 44.1kHz — coarse enough for energy VAD, cheap to process. */
const BLOCK_SIZE = 4096;

export function tapPcm(
  stream: MediaStream,
  onBlock: (block: Float32Array, rms: number, sampleRate: number) => void,
): PcmTap {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctor) return { stop: () => {} };

  try {
    const audio = new Ctor();
    const source = audio.createMediaStreamSource(stream);
    const proc = audio.createScriptProcessor(BLOCK_SIZE, 1, 1);
    const mute = audio.createGain();
    mute.gain.value = 0; // never play the mic back through the sink

    proc.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) {
        const v = input[i]!;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / input.length);
      // Copy: the input buffer is reused across callbacks, but the VAD retains blocks until phrase end.
      onBlock(new Float32Array(input), rms, audio.sampleRate);
    };

    source.connect(proc);
    proc.connect(mute);
    mute.connect(audio.destination);

    return {
      stop: () => {
        proc.onaudioprocess = null;
        try { proc.disconnect(); } catch { /* already torn down */ }
        try { source.disconnect(); } catch { /* already torn down */ }
        try { mute.disconnect(); } catch { /* already torn down */ }
        void audio.close().catch(() => {});
      },
    };
  } catch {
    return { stop: () => {} };
  }
}
