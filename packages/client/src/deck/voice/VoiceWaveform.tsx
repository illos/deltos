import { useEffect, useRef } from 'react';

/**
 * VoiceWaveform (#69 §6.1) — a live mic waveform (Web Audio AnalyserNode → canvas) so it's unmistakable
 * you're in voice mode. Editor-AGNOSTIC: takes the MediaStream from the recorder; draws the time-domain
 * waveform each frame. Stroke colour inherits the element's CSS `color` (themed via app tokens). Tears down
 * the AudioContext + rAF when the stream ends.
 */
interface VoiceWaveformProps {
  stream: MediaStream | null;
}

export function VoiceWaveform({ stream }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!stream || !canvas) return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const audio = new Ctor();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const stroke = getComputedStyle(canvas).color || '#888';
    let raf = 0;

    const draw = () => {
      const c = canvas.getContext('2d');
      if (c) {
        analyser.getByteTimeDomainData(data);
        const { width, height } = canvas;
        c.clearRect(0, 0, width, height);
        c.lineWidth = 2;
        c.strokeStyle = stroke;
        c.beginPath();
        const step = width / data.length;
        for (let i = 0; i < data.length; i++) {
          const y = (data[i]! / 128) * (height / 2); // 128 = silence midline
          if (i === 0) c.moveTo(0, y);
          else c.lineTo(i * step, y);
        }
        c.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void audio.close();
    };
  }, [stream]);

  return <canvas ref={canvasRef} className="voice-waveform" width={600} height={44} aria-hidden="true" />;
}
