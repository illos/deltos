/**
 * WAV encoding (#69 §6.2) — encode mono Float32 PCM into a standalone 16-bit PCM WAV Blob.
 *
 * The live-preview VAD (see ./vad.ts) cuts the mic audio into per-phrase PCM segments. Unlike a
 * MediaRecorder timeslice fragment (which isn't independently decodable — only the first fragment carries
 * the container header), a WAV with its own 44-byte header IS a self-contained file Whisper can transcribe.
 * So each phrase segment is encoded here before going to the (chunk-agnostic) Transcriber.
 *
 * deck-core, zero deps: pure ArrayBuffer math, no Web Audio / DOM beyond Blob.
 */

const WAV_HEADER_BYTES = 44;

/** Encode mono Float32 samples (-1..1) at `sampleRate` Hz into a 16-bit PCM WAV Blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2; // 16-bit
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF chunk descriptor
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeStr(8, 'WAVE');
  // fmt sub-chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bitsPerSample/8
  view.setUint16(34, 16, true); // bits per sample
  // data sub-chunk
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    // clamp then scale to signed 16-bit (asymmetric range: negative uses 0x8000, positive 0x7FFF)
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Concatenate Float32 PCM buffers into one (used to coalesce queued phrase segments into a single call). */
export function concatFloat32(buffers: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const b of buffers) total += b.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}
