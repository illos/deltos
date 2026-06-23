import { VoiceWaveform } from './VoiceWaveform.js';
import type { VoiceState } from './useVoiceMode.js';

/**
 * VoiceLoadout (#69 §6.1) — the Deck's TRANSCRIPT-MODE loadout (locked UX). While the mic is active this
 * REPLACES the keypad loadout: a full-width WAVEFORM in the top slot (another top-slot occupant, §5.1
 * infra), a transcript-preview PANE in the keypad footprint, and a base region with the Stop control.
 *
 * Editor-AGNOSTIC: it renders the voice-mode state the host's useVoiceMode produces; the host owns the
 * state machine + the injected Transcriber + the commit-to-note. Base scope NOW: the pane shows a recording
 * status (no live text) — the chunked live preview (§6.2) is an additive layer later; the final full-context
 * pass auto-commits on stop. `transcript` is the seam for that future preview.
 */
interface VoiceLoadoutProps {
  state: VoiceState;
  stream: MediaStream | null;
  /** Future §6.2 live-preview text; empty in the base (recording shows a status, not text). */
  transcript?: string;
  /** Stop recording (tap-toggle mode). Hold-to-talk stops on pointer release via the mic control. */
  onStop: () => void;
}

export function VoiceLoadout({ state, stream, transcript, onStop }: VoiceLoadoutProps) {
  return (
    <div className="voice-loadout">
      <div className="voice-loadout__wave">
        <VoiceWaveform stream={stream} />
      </div>
      <div className="voice-loadout__pane" aria-live="polite">
        {state === 'transcribing' ? (
          <span className="voice-loadout__status">Transcribing…</span>
        ) : transcript ? (
          <span className="voice-loadout__text">{transcript}</span>
        ) : (
          <span className="voice-loadout__status">Listening… tap Stop when you’re done</span>
        )}
      </div>
      <div className="voice-loadout__base">
        <button
          type="button"
          className="voice-loadout__stop"
          aria-label={state === 'transcribing' ? 'Transcribing' : 'Stop recording'}
          disabled={state === 'transcribing'}
          onPointerDown={(e) => { e.preventDefault(); onStop(); }}
        >
          {state === 'transcribing' ? 'Transcribing…' : '■ Stop'}
        </button>
      </div>
    </div>
  );
}
