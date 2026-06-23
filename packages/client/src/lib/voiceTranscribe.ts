import { useAuthStore } from '../auth/store.js';

/**
 * Voice CONSUME stage (custom-keyboard spec §6, stage 3) — the client-side transcription service.
 *
 * `transcribe(audio)` POSTs a captured audio blob to the authenticated POST /api/transcribe route and
 * returns BOTH the transcript AND the original audio blob. It is deliberately NOT coupled to any one
 * consumer:
 *   - the v1 DICTATION consumer takes `.transcript`, inserts it at the caret, and discards `.audio`;
 *   - a future VOICE MEMO consumer keeps `.audio` (→ Cloudflare R2) and stores `.transcript` as
 *     searchable note content.
 * The audio never round-trips the server — the caller already holds the blob from the capture stage, so
 * returning it here just keeps the artifact together with its transcript for whichever consumer wants it.
 */

/** The result of a transcription: the text plus the source audio, so the caller chooses what to keep. */
export interface Transcription {
  /** The transcript text from Whisper. */
  transcript: string;
  /** The original captured audio blob (unmodified) — kept by a VOICE MEMO consumer, dropped by dictation. */
  audio: Blob;
}

/** Thrown when the transcribe endpoint rejects the request or the model fails — callers surface a toast. */
export class TranscribeError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 for a network/transport failure. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'TranscribeError';
  }
}

/** The `Authorization: Bearer` header, read FRESH from the in-memory auth store (F7 — never persisted),
 *  matching the sync engine. When locked / signed out the token is null; the server then refuses in prod. */
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Transcribe a captured audio blob. The blob is sent as the raw request body with its own content type;
 * the server base64-encodes it for Whisper. Resolves with the transcript + the source audio; rejects with
 * a {@link TranscribeError} on auth/model/transport failure.
 */
export async function transcribe(audio: Blob, apiBase = '/api', final = false): Promise<Transcription> {
  // §6.2 clip-cap (secSys ruling): the chunked-FINAL full-audio pass sets ?final=1 so the server selects
  // its higher (25MB) cap instead of the 5MB dictation cap. The marker only SELECTS between two
  // server-defined bounded caps — it can't set an arbitrary size — so an untrusted value is safe. Per-phrase
  // chunk calls omit it (correctly capped at 5MB). The worker honours this in its two-cap route selection.
  let res: Response;
  try {
    res = await fetch(`${apiBase}/transcribe${final ? '?final=1' : ''}`, {
      method: 'POST',
      // The blob's own type drives the Content-Type so the server/Whisper sees the right container.
      headers: { 'Content-Type': audio.type || 'application/octet-stream', ...authHeader() },
      body: audio,
    });
  } catch {
    throw new TranscribeError('could not reach the transcription service', 0);
  }

  if (!res.ok) {
    // The API returns a JSON error envelope ({ error: { code, message } }); fall back to the status text.
    let message = res.statusText || 'transcription failed';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the status-text fallback.
    }
    throw new TranscribeError(message, res.status);
  }

  const body = (await res.json()) as { transcript?: string };
  return { transcript: body.transcript ?? '', audio };
}
