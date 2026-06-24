/**
 * #126 A4 — the attachment RENDER-ONLY view. A fetch-free chip in any read-only context (it never loads the
 * blob bytes — previews stay light; the no-access guard covers the whole render-only graph incl. this).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PluginBlockRenderOnly, resolveRenderOnly } from '../src/plugins/runtime/renderOnly.js';

afterEach(() => cleanup());

describe('#126 attachment render-only', () => {
  it('renders a fetch-free chip with name + size', () => {
    const { container } = render(
      <PluginBlockRenderOnly
        type="attachment"
        payload={{ hash: 'h', name: 'photo.png', mime: 'image/png', size: 2048 }}
        context="read-only-preview"
      />,
    );
    expect(container.querySelector('.attachment-chip')).not.toBeNull();
    expect(container.querySelector('.attachment-chip__name')?.textContent).toBe('photo.png');
    expect(container.textContent).toContain('2.0 KB');
  });

  it('renders identically offline (blob is offline-capable; metadata is all in the payload)', () => {
    const { container } = render(
      <PluginBlockRenderOnly type="attachment" payload={{ name: 'doc.pdf', size: 1500 }} context="offline" />,
    );
    expect(container.querySelector('.attachment-chip__name')?.textContent).toBe('doc.pdf');
  });

  it('resolveRenderOnly knows the attachment type', () => {
    expect(resolveRenderOnly('attachment')).toBeDefined();
  });
});
