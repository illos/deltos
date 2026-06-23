import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioRecorder } from './audioCapture.js';
import { tapPcm } from './pcmTap.js';
import type { PcmTap } from './pcmTap.js';
import { createVadSegmenter } from './vad.js';
import type { VadSegmenter } from './vad.js';
import { createChunkPreviewController } from './chunkPreview.js';
import type { ChunkPreviewController } from './chunkPreview.js';
import type { Transcriber } from './transcriber.js';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

/**
 * Peak-RMS threshold (0..1) below which a recording is treated as effectively silent → transcription is
 * SKIPPED and nothing is inserted. Whisper hallucinates filler ("Thank you") on no-speech audio, so we gate
 * at the source on audio energy rather than filtering output phrases (which can't tell a real "thank you"
 * from a hallucinated one). Real speech peaks well above this (~0.1+); room tone / silence sits far below.
 * Conservative (low) so genuine quiet speech is never dropped; tune on-device with the §6.2 VAD work.
 */
export const SILENCE_PEAK_THRESHOLD = 0.01;

/**
 * Hard max recording duration → auto-stop (secSys §6.2 bound). One lever covering two risks: (a) the
 * chunked-FINAL pass blob can't grow past the 25MB ?final cap, and (b) total live-preview chunk calls are
 * bounded (≈ duration / min-interval) so a forgotten/stuck mic can't rack up paid calls. 5 min is generous
 * for a long dictation while keeping the compressed final blob well under 25MB. The durable per-account
 * throttle (deferred, pre-real-users) is the eventual real bound.
 */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

export interface VoiceModeOptions {
  /**
   * §6.2 live preview: a CHUNK transcriber for per-phrase preview calls (NO ?final flag — small, 5MB cap).
   * Omit to disable the live preview entirely (base §6.1 behaviour: waveform + a final pass on stop).
   */
  chunkTranscriber?: (blob: Blob) => Promise<{ transcript: string }>;
  /** Override the auto-stop duration (ms). Defaults to {@link MAX_RECORDING_MS}. */
  maxDurationMs?: number;
}

export interface VoiceMode {
  state: VoiceState;
  /** The live mic stream while recording (for the waveform AnalyserNode); null otherwise. */
  stream: MediaStream | null;
  /** §6.2 rough live-preview transcript (greyed draft) accumulated during recording; '' when none. */
  draft: string;
  /** Begin recording. No-op unless idle. */
  start: () => Promise<void>;
  /** Stop recording → transcribe (injected) → hand the transcript to onTranscript. No-op unless recording. */
  stop: () => Promise<void>;
  /** Abort without transcribing (release the mic). */
  cancel: () => void;
}

/**
 * useVoiceMode — the Deck voice loadout's state machine (#69 §6.1b/§6.2), editor-AGNOSTIC. Records via the
 * relocated audioCapture, transcribes via the INJECTED Transcriber (the Deck never knows the backend), and
 * hands the final transcript to `onTranscript` (the host commits it to the note at caret). Lifecycle:
 * idle → recording → transcribing → idle.
 *
 * §6.2 live preview (opt-in via options.chunkTranscriber): while recording, a PCM tap → VAD phrase
 * segmenter → bounded single-flight+coalesce chunk controller transcribes rolling phrases into a rough
 * GREYED draft. On stop the preview pipeline is torn down WITHOUT a last-chunk call, then the authoritative
 * FINAL pass transcribes the full recording, REPLACES the draft, and commits. So the draft is purely
 * visual — correctness comes from the final pass.
 *
 * `transcriber` + `onTranscript` + `options` are read via refs, so start/stop/cancel stay stable.
 */
export function useVoiceMode(
  transcriber: Transcriber,
  onTranscript: (transcript: string) => void,
  options: VoiceModeOptions = {},
): VoiceMode {
  const [state, setState] = useState<VoiceState>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [draft, setDraft] = useState('');
  const stateRef = useRef<VoiceState>('idle');
  const recorderRef = useRef<ReturnType<typeof createAudioRecorder> | null>(null);
  const tapRef = useRef<PcmTap | null>(null);
  const vadRef = useRef<VadSegmenter | null>(null);
  const previewRef = useRef<ChunkPreviewController | null>(null);
  const draftRef = useRef('');
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest props/options without churning the callbacks.
  const transcriberRef = useRef(transcriber); transcriberRef.current = transcriber;
  const onTranscriptRef = useRef(onTranscript); onTranscriptRef.current = onTranscript;
  const optionsRef = useRef(options); optionsRef.current = options;
  // start() sets the auto-stop timer to call the LATEST stop.
  const stopRef = useRef<() => Promise<void>>(async () => {});

  const set = useCallback((s: VoiceState) => { stateRef.current = s; setState(s); }, []);

  const appendDraft = useCallback((text: string) => {
    draftRef.current = draftRef.current ? `${draftRef.current} ${text}` : text;
    setDraft(draftRef.current);
  }, []);

  /** Tear down the live-preview pipeline + the auto-stop timer (idempotent). Leaves the recorder alone. */
  const teardownPreview = useCallback(() => {
    if (autoStopRef.current !== null) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    tapRef.current?.stop(); tapRef.current = null;
    previewRef.current?.dispose(); previewRef.current = null;
    vadRef.current = null;
  }, []);

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
    draftRef.current = ''; setDraft('');
    set('recording');

    // §6.2 live preview: tap PCM → VAD → bounded chunk transcription → greyed draft. The VAD + controller
    // are created lazily on the first block (we need the runtime sampleRate). No-op if no chunkTranscriber.
    const chunkTranscriber = optionsRef.current.chunkTranscriber;
    if (chunkTranscriber && rec.stream) {
      tapRef.current = tapPcm(rec.stream, (block, rms, sampleRate) => {
        if (!previewRef.current) {
          const preview = createChunkPreviewController(sampleRate, chunkTranscriber, appendDraft);
          previewRef.current = preview;
          vadRef.current = createVadSegmenter(sampleRate, (seg) => preview.submit(seg));
        }
        vadRef.current?.push(block, rms);
      });
    }

    const maxMs = optionsRef.current.maxDurationMs ?? MAX_RECORDING_MS;
    autoStopRef.current = setTimeout(() => { void stopRef.current(); }, maxMs);
  }, [set, appendDraft]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || stateRef.current !== 'recording') return;
    // Stop the live-preview loop BEFORE the final pass — no wasted last-chunk paid call; the authoritative
    // final pass replaces the whole draft anyway.
    teardownPreview();
    set('transcribing');
    setStream(null);
    try {
      const { blob, peakLevel } = await rec.stop();
      // Silent clip (no speech) → skip the paid Whisper call entirely + insert nothing. Dodges Whisper's
      // no-speech hallucination at the source and saves a wasted call. (Fails open: peakLevel is 1 when
      // energy monitoring is unavailable, so we never wrongly suppress.)
      if (peakLevel < SILENCE_PEAK_THRESHOLD) return;
      const { transcript } = await transcriberRef.current.transcribe(blob); // final pass (host wires ?final=1)
      if (transcript.trim().length > 0) onTranscriptRef.current(transcript);
    } catch {
      // capture/transcribe failed — exit voice mode quietly (host-level error UI is a later concern).
    } finally {
      recorderRef.current = null;
      draftRef.current = ''; setDraft('');
      set('idle');
    }
  }, [set, teardownPreview]);
  stopRef.current = stop;

  const cancel = useCallback(() => {
    teardownPreview();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setStream(null);
    draftRef.current = ''; setDraft('');
    set('idle');
  }, [set, teardownPreview]);

  // Unmount safety: never leak the tap / chunk loop / auto-stop timer.
  useEffect(() => () => { teardownPreview(); }, [teardownPreview]);

  return { state, stream, draft, start, stop, cancel };
}
