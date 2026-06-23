/**
 * Transcriber — the transcription capability the Deck's voice loadout CALLS but does NOT implement
 * (#69 §6.1b). Deck-core defines the interface + the voice UI; the HOST injects a concrete implementation
 * (in deltos: POST /api/transcribe → Cloudflare Workers AI Whisper, with the bearer). The Deck never knows
 * the backend — any embedding app brings its own transcriber. One-way dependency, same as the keypad's
 * KeyActions and the spellcheck SpellEngine.
 */
export interface Transcriber {
  /** Transcribe a captured audio blob into its text. Rejects on failure (the host surfaces the error). */
  transcribe(blob: Blob): Promise<{ transcript: string }>;
}
