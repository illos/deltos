/**
 * #124 A2 — the render-only contract (§5 fork b). A plugin block renders read-only OUTSIDE an editor via a
 * pure (payload, context) → component, with NO ProseMirror. link_card is the proving case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PluginBlockRenderOnly, resolveRenderOnly } from '../src/plugins/runtime/renderOnly.js';

afterEach(() => cleanup());

describe('#124 render-only — link_card outside an editor', () => {
  it('renders the read-only card (anchor + title + url, NO downgrade button)', () => {
    const { container } = render(
      <PluginBlockRenderOnly
        type="link_card"
        payload={{ url: 'https://example.com', title: 'Example Site' }}
        context="read-only-preview"
      />,
    );
    const card = container.querySelector('a.link-card--readonly') as HTMLAnchorElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('.link-card__title')?.textContent).toBe('Example Site');
    expect(container.querySelector('.link-card__url')?.textContent).toBe('https://example.com');
    // read-only: no edit affordance
    expect(container.querySelector('.link-card__downgrade')).toBeNull();
  });

  it('an unrecognized block type renders a lossless raw placeholder (never vanishes)', () => {
    const payload = { secret: 'preserved' };
    const { container } = render(<PluginBlockRenderOnly type="mystery" payload={payload} context="shared" />);
    const ph = container.querySelector('.editor-plugin-island--unknown') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toBe('Unknown block [mystery]');
    expect(ph.getAttribute('data-plugin-type')).toBe('mystery');
    expect(payload).toEqual({ secret: 'preserved' }); // untouched
  });

  it('resolveRenderOnly maps known → component, unknown → undefined', () => {
    expect(resolveRenderOnly('link_card')).toBeDefined();
    expect(resolveRenderOnly('nope')).toBeUndefined();
  });
});
