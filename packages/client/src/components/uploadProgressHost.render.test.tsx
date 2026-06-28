/**
 * UploadProgressHost (direct-r2-upload.md §6.3, gate DR-5 / standing ui-features-need-rendered-ui-gate) —
 * mounts the REAL component over the real upload store and proves the progress affordance renders + behaves:
 *   - an in-flight upload renders a card with the filename, the live percent, and a progressbar at that percent;
 *   - the Cancel control calls the entry's stored cancel() (which aborts the XHR upstream);
 *   - the card disappears when the upload settles (finish), leaving no orphan UI (upload-first: no note row).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { UploadProgressHost } from './UploadProgressHost.js';
import { useUploadStore } from '../lib/uploadStore.js';

beforeEach(() => useUploadStore.setState({ uploads: [] }));
afterEach(cleanup);

describe('UploadProgressHost', () => {
  it('renders nothing when there are no in-flight uploads', () => {
    const { container } = render(<UploadProgressHost />);
    expect(container.querySelector('.upload-host')).toBeNull();
  });

  it('renders a card with filename, live percent, and a progressbar during a direct upload', () => {
    const { container } = render(<UploadProgressHost />);
    let id = '';
    act(() => { id = useUploadStore.getState().start('huge.pdf', () => {}); });

    expect(container.querySelector('.upload-card__name')?.textContent).toBe('huge.pdf');
    expect(container.querySelector('.upload-card__pct')?.textContent).toBe('0%');

    act(() => useUploadStore.getState().setProgress(id, 0.42));
    expect(container.querySelector('.upload-card__pct')?.textContent).toBe('42%');
    const bar = container.querySelector('.upload-card__bar') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect((container.querySelector('.upload-card__fill') as HTMLElement).style.width).toBe('42%');
  });

  it('Cancel calls the entry stored cancel() (aborts the upload)', () => {
    const { container } = render(<UploadProgressHost />);
    let cancelled = false;
    act(() => { useUploadStore.getState().start('huge.pdf', () => { cancelled = true; }); });

    const cancelBtn = container.querySelector('.upload-card__cancel') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    fireEvent.click(cancelBtn);
    expect(cancelled).toBe(true);
  });

  it('the card disappears when the upload settles (no orphan UI)', () => {
    const { container } = render(<UploadProgressHost />);
    let id = '';
    act(() => { id = useUploadStore.getState().start('huge.pdf', () => {}); });
    expect(container.querySelector('.upload-card')).not.toBeNull();

    act(() => useUploadStore.getState().finish(id));
    expect(container.querySelector('.upload-card')).toBeNull();
    expect(container.querySelector('.upload-host')).toBeNull();
  });
});
