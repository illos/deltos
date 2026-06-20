import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ICONS, IconGallery } from './IconGallery.js';
import { Search, SyncDot } from './index.js';

afterEach(cleanup);

/**
 * Render/smoke gate for the icon set. Proves every icon mounts to a well-formed 24-grid SVG with the
 * theme-able currentColor stroke, and that the shared IconBase contract (size, title a11y, className
 * pass-through, fill overrides) holds. Covers the design-packet invariants for Lane 1.
 */
describe('icon set', () => {
  it('exposes exactly the 27 design-packet icons', () => {
    expect(ICONS).toHaveLength(27);
    // names are unique
    expect(new Set(ICONS.map((i) => i.name)).size).toBe(ICONS.length);
  });

  it('every icon renders one 24×24 currentColor SVG', () => {
    for (const { name, Component } of ICONS) {
      const { container, unmount } = render(<Component />);
      const svg = container.querySelector('svg');
      expect(svg, `${name} should render an <svg>`).not.toBeNull();
      expect(svg!.getAttribute('viewBox'), name).toBe('0 0 24 24');
      expect(svg!.getAttribute('stroke'), name).toBe('currentColor');
      expect(svg!.getAttribute('stroke-linecap'), name).toBe('round');
      expect(svg!.getAttribute('stroke-linejoin'), name).toBe('round');
      // fine-line weight stays inside the 1.4–1.7 band
      const w = Number(svg!.getAttribute('stroke-width'));
      expect(w, `${name} stroke-width`).toBeGreaterThanOrEqual(1.4);
      expect(w, `${name} stroke-width`).toBeLessThanOrEqual(1.7);
      // each icon draws at least one shape
      expect(svg!.children.length, `${name} should have geometry`).toBeGreaterThan(0);
      unmount();
    }
  });

  it('is decorative (aria-hidden) by default, labeled (role=img + <title>) when titled', () => {
    const { container, rerender } = render(<Search />);
    let svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();

    rerender(<Search title="Search notes" />);
    svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.getAttribute('role')).toBe('img');
    expect(screen.getByTitle('Search notes')).toBeTruthy();
  });

  it('size sets width + height; defaults to 20', () => {
    const { container, rerender } = render(<Search />);
    let svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');

    rerender(<Search size={32} />);
    svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
  });

  it('forwards className, style and arbitrary svg props', () => {
    const { container } = render(<Search className="nav-icon" data-testid="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg.classList.contains('nav-icon')).toBe(true);
    expect(svg.getAttribute('data-testid')).toBe('x');
  });

  it('filled icons draw a currentColor fill (sync-dot)', () => {
    const { container } = render(<SyncDot />);
    const disc = container.querySelector('circle')!;
    expect(disc.getAttribute('fill')).toBe('currentColor');
    expect(disc.getAttribute('stroke')).toBe('none');
  });

  it('the gallery mounts every icon with its label', () => {
    render(<IconGallery />);
    for (const { name } of ICONS) {
      // `name` appears twice per cell (the SVG <title> for a11y + the visible label); assert the
      // visible <span> label is present.
      const labels = screen.getAllByText(name);
      expect(labels.some((el) => el.tagName === 'SPAN'), name).toBe(true);
    }
  });
});
