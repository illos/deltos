import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLightboxStore } from '../lib/lightboxStore.js';
import './Lightbox.css';

/**
 * Full-screen image viewer. Mounted ONCE per shell surface (App.tsx) but renders `null` until an image is
 * tapped (near-zero cost — perf north-star), so mounting it everywhere is free. Portals to <body> to escape
 * the 3-region panes' `overflow:hidden`. Closes on backdrop tap, the ✕, or Escape; a tap on the image itself
 * is swallowed so it never closes. The image is the already-loaded object URL from the store → no refetch.
 */
export function Lightbox() {
  const open = useLightboxStore((s) => s.open);
  const src = useLightboxStore((s) => s.src);
  const alt = useLightboxStore((s) => s.alt);
  const close = useLightboxStore((s) => s.close);

  // Escape closes — listener lives only while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || !src) return null;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={close}>
      <button
        type="button"
        className="lightbox__close"
        aria-label="Close"
        // stop so the backdrop's onClick doesn't also fire (both close, but keep the intent explicit)
        onClick={(e) => { e.stopPropagation(); close(); }}
        autoFocus
      >
        ✕
      </button>
      {/* Tap on the image must NOT close (only the backdrop does) — swallow the click. */}
      <img
        className="lightbox__img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
