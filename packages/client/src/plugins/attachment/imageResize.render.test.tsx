import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { computeResizeWidth, applyWidthToContent, MIN_IMAGE_WIDTH } from './imageResize.js';
import { ResizableImage } from './AttachmentNodeView.js';
import { useLightboxStore } from '../../lib/lightboxStore.js';

/**
 * Drag-resize for inline images (DEC-0001 salvage). The pointer plumbing lives in the NodeView; the clamp math
 * and the payload merge are pure (tested here without a live PM view), and a light render assert proves the
 * persisted width reaches the DOM and the reset gesture fires a `undefined` commit.
 */

afterEach(cleanup);

describe('computeResizeWidth', () => {
  it('adds the pointer travel to the grab-point width', () => {
    expect(computeResizeWidth(200, 50, 1000)).toBe(250);
    expect(computeResizeWidth(200, -50, 1000)).toBe(150);
  });

  it('never upscales past the natural intrinsic width (1:1 cap)', () => {
    expect(computeResizeWidth(600, 500, 640)).toBe(640);
  });

  it('never shrinks below the MIN floor', () => {
    expect(computeResizeWidth(100, -900, 1000)).toBe(MIN_IMAGE_WIDTH);
  });

  it('treats naturalWidth 0 (not yet decoded) as no upper cap', () => {
    expect(computeResizeWidth(300, 5000, 0)).toBe(5300);
  });

  it('rounds to whole pixels', () => {
    expect(computeResizeWidth(200.4, 10.2, 1000)).toBe(211);
  });
});

describe('applyWidthToContent', () => {
  it('sets width, passing other payload fields through untouched', () => {
    const base = { hash: 'h', name: 'a.png', mime: 'image/png', size: 10 };
    const next = applyWidthToContent(base, 240);
    expect(next).toEqual({ hash: 'h', name: 'a.png', mime: 'image/png', size: 10, width: 240 });
  });

  it('drops width entirely on reset (undefined)', () => {
    const base = { hash: 'h', width: 240 };
    const next = applyWidthToContent(base, undefined);
    expect(next).toEqual({ hash: 'h' });
    expect('width' in next).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = { hash: 'h', width: 100 };
    applyWidthToContent(input, 300);
    expect(input.width).toBe(100);
  });
});

describe('ResizableImage', () => {
  it('renders the persisted width as an inline px style', () => {
    const { container } = render(<ResizableImage src="blob:x" alt="pic" width={220} onCommitWidth={vi.fn()} />);
    const img = container.querySelector('img.attachment-image') as HTMLImageElement;
    expect(img.style.width).toBe('220px');
  });

  it('renders natural size (no inline width) when width is absent', () => {
    const { container } = render(<ResizableImage src="blob:x" alt="pic" width={undefined} onCommitWidth={vi.fn()} />);
    const img = container.querySelector('img.attachment-image') as HTMLImageElement;
    expect(img.style.width).toBe('');
  });

  it('shows the grip only when a committer is supplied (edit path)', () => {
    const editable = render(<ResizableImage src="blob:x" alt="pic" width={undefined} onCommitWidth={vi.fn()} />);
    expect(editable.container.querySelector('.attachment-resize-grip')).not.toBeNull();
    cleanup();
    const readOnly = render(<ResizableImage src="blob:x" alt="pic" width={undefined} />);
    expect(readOnly.container.querySelector('.attachment-resize-grip')).toBeNull();
  });

  it('double-clicking the grip commits an undefined width (reset to natural)', () => {
    const onCommitWidth = vi.fn();
    const { container } = render(<ResizableImage src="blob:x" alt="pic" width={300} onCommitWidth={onCommitWidth} />);
    const grip = container.querySelector('.attachment-resize-grip') as HTMLElement;
    fireEvent.doubleClick(grip);
    expect(onCommitWidth).toHaveBeenCalledWith(undefined);
  });

  it('tapping the image opens the lightbox with its src', () => {
    useLightboxStore.getState().close(); // clean slate
    const { container } = render(<ResizableImage src="blob:pic-url" alt="a cat" width={undefined} onCommitWidth={vi.fn()} />);
    const img = container.querySelector('img.attachment-image') as HTMLImageElement;
    fireEvent.click(img);
    expect(useLightboxStore.getState()).toMatchObject({ open: true, src: 'blob:pic-url', alt: 'a cat' });
    useLightboxStore.getState().close();
  });
});
