import { create } from 'zustand';

/**
 * Full-screen image lightbox (tap an inline note image → view it fit-to-screen). ONE tiny singleton store so
 * the image — which renders inside the NodeView's OWN React root (AttachmentNodeView), a subtree separate from
 * the app shell — can open the overlay that lives in the shell, without a shared React context spanning the two
 * roots. `src` is the already-loaded object URL, so the overlay re-uses it with no refetch.
 */
interface LightboxState {
  open: boolean;
  /** The object URL to display, or null when closed. */
  src: string | null;
  alt: string;
  openLightbox: (src: string, alt?: string) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>((set) => ({
  open: false,
  src: null,
  alt: '',
  openLightbox: (src, alt = '') => set({ open: true, src, alt }),
  close: () => set({ open: false, src: null, alt: '' }),
}));
