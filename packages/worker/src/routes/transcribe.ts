import { Hono } from 'hono';
import type { AppEnv, AppContext } from '../context.js';
import { apiError, NON_PROD_ENVIRONMENTS } from '../http.js';
import { resolvePrincipal } from '../auth.js';
import { chargeUsage, quotaExceeded } from '../usage.js';

/**
 * Voice-to-text TRANSCRIBE stage (custom-keyboard spec §6, stage 2) — the decoupled server half of the
 * voice pipeline. A single authenticated endpoint that turns an uploaded audio blob into a transcript via
 * Cloudflare Workers AI Whisper. It is deliberately NOT coupled to any consumer: it returns the transcript
 * as a first-class artifact, so dictation (insert-at-caret, discard audio) and a future VOICE MEMO note
 * type (keep audio → R2, store transcript as searchable note content) are both just callers.
 *
 * AUTH: the existing bearer/session, resolved through the SAME chokepoint pieces the note routes use — a
 * real `Authorization: Bearer` grant resolves a principal; the F13 fail-closed tripwire refuses the
 * dev-only `unverified` stub outside an explicit non-prod environment. This is NOT a new auth-bypass route:
 * in production an unauthenticated/forged caller is rejected before any (paid) inference runs. There is no
 * stored resource here (no note/notebook), so the op/resource `can()` machinery does not apply — the gate
 * is simply "is this a real authenticated account."
 *
 * BINDING: `env.AI` (Workers AI). Stood up here; the same binding is reused later by the advanced-LLM
 * spellcheck add-on. Fail-closed (503) if it is unbound, mirroring the other secret/binding-gated routes.
 *
 * GOTCHA: Workers AI has no local inference — `wrangler dev` cannot run Whisper; use `wrangler dev --remote`
 * or a deploy to exercise the real model. Unit tests inject a stub `AI` binding.
 */

/** The Whisper model — large-v3-turbo. Its `audio` input is a BASE64 string (NOT the uint8 array the
 *  legacy `@cf/openai/whisper` takes); its output `.text` is the full transcript. */
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** §6.1 dictation + every §6.2 per-phrase chunk call (no ?final). */
const MAX_AUDIO_DICTATION = 5 * 1024 * 1024;

/**
 * §6.2 full-audio final pass (?final=1, sent on recording stop). 5-min auto-stop at 256 kbps ≈ 9.6 MB
 * worst-case; 25 MB gives ample headroom and matches the original plumbing cap. Do NOT raise without a
 * secSys ruling. The ?final param only selects between these two SERVER-DEFINED bounded caps — it does NOT
 * let the caller set an arbitrary size.
 *
 * ✅ ENFORCED (Tier-2, ROAD-0005 P4) — PER-ACCOUNT DAILY QUOTA: the durable denial-of-wallet cap now charges
 * every call to this endpoint (chargeUsage(c, principal.id, 'transcribe'); DAILY_QUOTA.transcribe/account/day,
 * 429 over-budget). This closes the secSys @c1210fc deferral, which flagged a per-account throttle as
 * HARD-REQUIRED before >1 user but explicitly did NOT waive it. Per-call size stays capped below (MAX_AUDIO_*).
 */
const MAX_AUDIO_FINAL = 25 * 1024 * 1024;

export const transcribe = new Hono<AppEnv>();

transcribe.post('/', async (c: AppContext) => {
  // 1. Authenticate via the existing bearer/session. Same tripwire as guard(): a present+valid bearer
  //    resolves a real principal; no/unknown bearer → the dev stub, which production refuses here.
  const principal = await resolvePrincipal(c);
  if (
    principal.verification.method === 'unverified' &&
    !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')
  ) {
    return apiError(c, 401, 'unauthorized', 'transcription requires an authenticated session');
  }

  // 2. The AI binding must be wired — fail-closed (no silent degrade) like the other binding-gated routes.
  if (!c.env.AI) {
    return apiError(c, 503, 'ai_not_configured', 'transcription is unavailable (AI binding unbound)');
  }

  // 3. Tier-2 denial-of-wallet daily quota (ROAD-0005 P4). Charge the server-derived account (principal.id —
  //    BOLA-safe, never a body field) BEFORE buffering the body or running (paid) Whisper inference, so an
  //    over-budget account pays nothing to be rejected. Fail-CLOSED: a chargeUsage D1 error throws rather
  //    than allows, the correct posture for the cost guard.
  const decision = await chargeUsage(c, principal.id, 'transcribe');
  if (!decision.allowed) {
    return quotaExceeded(c, decision);
  }

  // 4. Select the cap: ?final=1 = §6.2 full-audio final pass (25 MB); everything else = 5 MB.
  //    Exact '1' match only — any other value falls back to the dictation cap.
  const cap = c.req.query('final') === '1' ? MAX_AUDIO_FINAL : MAX_AUDIO_DICTATION;

  // 5. Content-Length precheck: reject before buffering if the declared size already exceeds the cap.
  //    Without this, arrayBuffer() pulls up to the platform's ~100MB body limit into Worker memory before
  //    we can reject — a memory-pressure amplifier on a 128MB budget. If the client lies low (declares
  //    small, sends large), the post-buffer check below still catches it.
  const declaredLen = parseInt(c.req.header('content-length') ?? '', 10);
  if (!Number.isNaN(declaredLen) && declaredLen > cap) {
    return apiError(c, 413, 'payload_too_large', 'audio exceeds the maximum size for a single transcription');
  }

  // 6–8. Buffer, validate, run.
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    return apiError(c, 400, 'invalid_request', 'empty audio body');
  }
  if (buf.byteLength > cap) {
    return apiError(c, 413, 'payload_too_large', 'audio exceeds the maximum size for a single transcription');
  }

  // 9. Run Whisper. v3-turbo wants base64 audio; it auto-detects the container (webm/opus from Chromium
  //    MediaRecorder, mp4/aac from Safari — both fine).
  const audioBase64 = bytesToBase64(new Uint8Array(buf));
  let text: string;
  try {
    const result = await c.env.AI.run(WHISPER_MODEL, { audio: audioBase64 });
    text = result.text ?? '';
  } catch {
    // Inference failures (model error, transient capacity) surface as a clean 502 rather than a 500 stack.
    return apiError(c, 502, 'transcription_failed', 'the transcription model could not process this audio');
  }

  // 10. Return the transcript as the first-class artifact. The audio stays client-side (the caller already
  //    holds the blob) — a future VOICE MEMO consumer keeps it; dictation discards it.
  return c.json({ transcript: text });
});

/**
 * Base64-encode raw bytes without blowing the call stack on large buffers. `btoa(String.fromCharCode(...))`
 * spreads every byte as an argument and overflows on multi-MB audio, so chunk the string build.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // 32 KB per String.fromCharCode call — well under the arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
