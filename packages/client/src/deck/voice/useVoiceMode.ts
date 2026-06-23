import { useCallback, useRef, useState } from 'react';
import { createAudioRecorder } from './audioCapture.js';
import type { Transcriber } from './transcriber.js';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

export interface VoiceMode {
  state: VoiceState;
  /** The live mic stream while recording (for the waveform AnalyserNode); null otherwise. */
  stream: MediaStream | null;
  /** Begin recording. No-op unless idle. */
  start: () => Promise<void>;
  /** Stop recording → transcribe (injected) → hand the transcript to onTranscript. No-op unless recording. */
  stop: () => Promise<void>;
  /** Abort without transcribing (release the mic). */
  cancel: () => void;
}

/**
 * useVoiceMode — the Deck voice loadout's state machine (#69 §6.1b), editor-AGNOSTIC. Records via the
 * relocated audioCapture, transcribes via the INJECTED Transcriber (the Deck never knows the backend), and
 * hands the final transcript to `onTranscript` (the host commits it to the note at caret). Lifecycle:
 * idle → recording → transcribing → idle. The host drives start/stop from the mic control and publishes the
 * VoiceLoadout while state !== 'idle'. Single-flight on the actual paid call lives in the injected
 * Transcriber (deltos adapter); this just sequences capture → transcribe and exposes the state + mic stream.
 *
 * `transcriber` + `onTranscript` should be stable (the host memoizes them) so start/stop stay stable.
 */
export function useVoiceMode(transcriber: Transcriber, onTranscript: (transcript: string) => void): VoiceMode {
  const [state, setState] = useState<VoiceState>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const stateRef = useRef<VoiceState>('idle');
  const recorderRef = useRef<ReturnType<typeof createAudioRecorder> | null>(null);
  const set = useCallback((s: VoiceState) => { stateRef.current = s; setState(s); }, []);

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    const rec = createAudioRecorder();
    recorderRef.current = rec;
    try {
      await rec.start();
    } catch {
      recorderRef.current = null; // mic denied / unsupported → stay idle
      return;
    }
    setStream(rec.stream);
    set('recording');
  }, [set]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || stateRef.current !== 'recording') return;
    set('transcribing');
    setStream(null);
    try {
      const { blob } = await rec.stop();
      const { transcript } = await transcriber.transcribe(blob);
      if (transcript.trim().length > 0) onTranscript(transcript);
    } catch {
      // capture/transcribe failed — exit voice mode quietly (host-level error UI is a later concern).
    } finally {
      recorderRef.current = null;
      set('idle');
    }
  }, [transcriber, onTranscript, set]);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setStream(null);
    set('idle');
  }, [set]);

  return { state, stream, start, stop, cancel };
}
