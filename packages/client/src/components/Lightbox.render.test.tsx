import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { Lightbox } from './Lightbox.js';
import { useLightboxStore } from '../lib/lightboxStore.js';

/**
 * The tap-to-view image lightbox. The store bridges the NodeView's separate React root to this shell-mounted
 * host; here we drive the store directly and assert the overlay's open/close behaviour. Store mutations run
 * inside act() so the mounted <Lightbox/> subscriber flushes its re-render before we query the DOM.
 */

const open = (src: string, alt?: string) => act(() => { useLightboxStore.getState().openLightbox(src, alt); });

afterEach(() => {
  cleanup();
  act(() => useLightboxStore.getState().close());
});

describe('lightboxStore', () => {
  it('opens with src/alt and closes back to empty', () => {
    useLightboxStore.getState().openLightbox('blob:z', 'zed');
    expect(useLightboxStore.getState()).toMatchObject({ open: true, src: 'blob:z', alt: 'zed' });
    useLightboxStore.getState().close();
    expect(useLightboxStore.getState()).toMatchObject({ open: false, src: null, alt: '' });
  });

  it('defaults alt to empty string when omitted', () => {
    useLightboxStore.getState().openLightbox('blob:z');
    expect(useLightboxStore.getState().alt).toBe('');
  });
});

describe('Lightbox', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<Lightbox />);
    expect(container.firstChild).toBeNull();
    expect(document.querySelector('.lightbox')).toBeNull();
  });

  it('renders the image (portaled to body) with the store src when open', () => {
    render(<Lightbox />);
    open('blob:pic', 'a pic');
    const img = document.querySelector('img.lightbox__img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:pic');
    expect(img.getAttribute('alt')).toBe('a pic');
  });

  it('closes on a backdrop click', () => {
    render(<Lightbox />);
    open('blob:pic', '');
    fireEvent.click(document.querySelector('.lightbox') as HTMLElement);
    expect(useLightboxStore.getState().open).toBe(false);
  });

  it('closes on the ✕ button', () => {
    render(<Lightbox />);
    open('blob:pic', '');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(useLightboxStore.getState().open).toBe(false);
  });

  it('closes on Escape', () => {
    render(<Lightbox />);
    open('blob:pic', '');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useLightboxStore.getState().open).toBe(false);
  });

  it('does NOT close when the image itself is clicked', () => {
    render(<Lightbox />);
    open('blob:pic', '');
    fireEvent.click(document.querySelector('img.lightbox__img') as HTMLElement);
    expect(useLightboxStore.getState().open).toBe(true);
  });
});
