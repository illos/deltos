#!/usr/bin/env node
/**
 * Voice-to-text TRANSCRIBE deploy smoke (custom-keyboard spec §6, stage 2).
 *
 * A one-action, team-side smoke that confirms the FULL server round-trip on the LIVE deploy:
 *   bearer auth → POST /api/transcribe → Workers AI Whisper → transcript.
 * Workers AI has NO local inference, so this is the real verification (unit tests stub the AI binding,
 * and `wrangler dev --remote` hits the no-TTY CF-token wall from the agent shell — see the team's
 * wrangler-d1-prod-route-to-user landmine). Run it AFTER pilot deploys.
 *
 * This is a TEMP dev harness (the #68-probe analogue), NOT a mic-key — the real Deck mic consumer is a
 * separate lane. It is also not part of Jim's review; it is an automated team check.
 *
 *   node packages/worker/scripts/smoke-transcribe.mjs [audioFilePath] [baseUrl]
 *
 *   audioFilePath  optional — a short speech clip (.webm/.mp4/.wav/.mp3) for a MEANINGFUL transcript.
 *                  Omitted → a 1s synthetic WAV tone is sent; that still proves the plumbing (HTTP 200 +
 *                  a `transcript` field) but Whisper won't return real words from a tone.
 *   baseUrl        optional — defaults to https://deltos.blackgate.studio (live = dev for this project).
 *
 * PASS criterion (plumbing): HTTP 200 with a `transcript` field. A real speech clip additionally verifies
 * transcription quality. A throwaway account is registered to obtain the bearer (data is disposable).
 */
import { readFileSync } from 'node:fs';

const [, , audioPathArg, baseUrlArg] = process.argv;
const BASE = (baseUrlArg ?? 'https://deltos.blackgate.studio').replace(/\/$/, '');

/** Build a minimal valid 16-bit PCM mono WAV (1s @ 16kHz, 440Hz tone) so the round-trip has real audio. */
function syntheticWav() {
  const sampleRate = 16000;
  const seconds = 1;
  const n = sampleRate * seconds;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0x3fff);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return { bytes: buf, contentType: 'audio/wav' };
}

function contentTypeFor(path) {
  if (path.endsWith('.webm')) return 'audio/webm';
  if (path.endsWith('.mp4') || path.endsWith('.m4a')) return 'audio/mp4';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

async function main() {
  console.log(`[smoke] target: ${BASE}`);

  // 1. Register a throwaway account to obtain a live bearer (data is disposable in this phase).
  const username = `smoke-voice-${Date.now()}`;
  const password = 'smoke test correct horse battery staple';
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!signup.ok) {
    console.error(`[smoke] FAIL — signup returned ${signup.status}: ${await signup.text()}`);
    process.exit(1);
  }
  const { token } = await signup.json();
  if (!token) {
    console.error('[smoke] FAIL — signup did not return a bearer token');
    process.exit(1);
  }
  console.log(`[smoke] authed as ${username}`);

  // 2. Prepare the audio.
  let bytes;
  let contentType;
  if (audioPathArg) {
    bytes = readFileSync(audioPathArg);
    contentType = contentTypeFor(audioPathArg);
    console.log(`[smoke] audio: ${audioPathArg} (${bytes.length} bytes, ${contentType})`);
  } else {
    const wav = syntheticWav();
    bytes = wav.bytes;
    contentType = wav.contentType;
    console.log(`[smoke] audio: synthetic 1s tone (${bytes.length} bytes, ${contentType}) — pass = round-trip, not words`);
  }

  // 3. Transcribe.
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/transcribe`, {
    method: 'POST',
    headers: { 'content-type': contentType, Authorization: `Bearer ${token}` },
    body: bytes,
  });
  const ms = Date.now() - t0;

  if (!res.ok) {
    console.error(`[smoke] FAIL — /api/transcribe returned ${res.status} in ${ms}ms: ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  if (typeof body.transcript !== 'string') {
    console.error(`[smoke] FAIL — 200 but no transcript field: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`[smoke] PASS — round-trip OK in ${ms}ms. transcript: ${JSON.stringify(body.transcript)}`);
}

main().catch((e) => {
  console.error(`[smoke] FAIL — ${e?.stack ?? e}`);
  process.exit(1);
});
