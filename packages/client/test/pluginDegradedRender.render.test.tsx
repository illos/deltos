/**
 * #125 A3 — capability model + degraded render (§4). An online-only block shows a cached/degraded form when
 * offline, NEVER broken. Degradation is PRESENTATION ONLY (secSys #679) — it never gates access/fetch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PluginBlockRenderOnly } from '../src/plugins/runtime/renderOnly.js';
import { shouldDegrade, deriveReadContext } from '../src/plugins/runtime/renderContext.js';

afterEach(() => cleanup());

const renderCard = (payload: unknown, context: Parameters<typeof PluginBlockRenderOnly>[0]['context']) =>
  render(<PluginBlockRenderOnly type="link_card" payload={payload} context={context} />).container;

describe('#125 shouldDegrade policy (render-degradation only)', () => {
  it('online-only degrades ONLY when offline', () => {
    expect(shouldDegrade('online-only', 'offline')).toBe(true);
    expect(shouldDegrade('online-only', 'read-only-preview')).toBe(false);
    expect(shouldDegrade('online-only', 'live-edit')).toBe(false);
    expect(shouldDegrade('online-only', 'shared')).toBe(false);
  });

  it('offline-capable blocks never degrade', () => {
    expect(shouldDegrade('offline', 'offline')).toBe(false);
  });

  it('deriveReadContext maps app state → context', () => {
    expect(deriveReadContext({ online: true })).toBe('read-only-preview');
    expect(deriveReadContext({ online: false })).toBe('offline');
    expect(deriveReadContext({ online: false, shared: true })).toBe('shared');
  });
});

describe('#125 link_card degraded render', () => {
  it('offline + NO cached metadata → a plain legible link, not a broken card', () => {
    const c = renderCard({ url: 'https://example.com', loading: true }, 'offline');
    const degraded = c.querySelector('a.link-card--degraded') as HTMLAnchorElement;
    expect(degraded).not.toBeNull();
    expect(degraded.getAttribute('href')).toBe('https://example.com');
    expect(degraded.textContent).toBe('https://example.com');
    // not the full card chrome
    expect(c.querySelector('.link-card__url')).toBeNull();
    expect(c.querySelector('.link-card--readonly')).toBeNull();
  });

  it('offline + CACHED metadata → the full card (works from payload, no network)', () => {
    const c = renderCard({ url: 'https://example.com', title: 'Example Site' }, 'offline');
    expect(c.querySelector('a.link-card--readonly')).not.toBeNull();
    expect(c.querySelector('.link-card__title')?.textContent).toBe('Example Site');
    expect(c.querySelector('.link-card--degraded')).toBeNull();
  });

  it('read-only-preview (online) → the full card even with no cached metadata (not degraded)', () => {
    const c = renderCard({ url: 'https://example.com', loading: true }, 'read-only-preview');
    expect(c.querySelector('a.link-card--readonly')).not.toBeNull();
    expect(c.querySelector('.link-card--degraded')).toBeNull();
  });
});
