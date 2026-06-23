/**
 * LinkCard render tests (§5 E2a — presentational component).
 *
 * LC-1  Loading state: shows favicon-placeholder + title-placeholder + raw URL
 * LC-2  Resolved state: shows favicon img + title + url
 * LC-3  Error state: shows favicon-placeholder + URL as title fallback
 * LC-4  Missing title (non-loading): falls back to showing URL as title
 * LC-5  onOpen fires when the card body is clicked
 * LC-6  onDowngrade fires when × is clicked; does NOT trigger onOpen
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { screen } from './renderHelpers.js';
import { LinkCard } from '../src/plugins/embeds/LinkCard.js';

const URL = 'https://example.com/article';

afterEach(cleanup);

// ── LC-1: Loading state ───────────────────────────────────────────────────────

describe('LC-1 — loading state', () => {
  it('shows favicon placeholder, URL in subtext, no resolved title', () => {
    render(
      <LinkCard url={URL} loading onOpen={vi.fn()} onDowngrade={vi.fn()} />,
    );
    // favicon-placeholder present (no img)
    expect(document.querySelector('.link-card__favicon-placeholder')).not.toBeNull();
    expect(document.querySelector('.link-card__favicon')).toBeNull();
    // raw URL visible in subtext
    expect(screen.queryByText(URL)).not.toBeNull();
    // no resolved title text (only skeleton placeholder or URL fallback, not a separate title)
    expect(document.querySelector('.link-card__title--placeholder')).not.toBeNull();
  });
});

// ── LC-2: Resolved state ──────────────────────────────────────────────────────

describe('LC-2 — resolved state', () => {
  it('shows favicon img, title, and URL subtext', () => {
    render(
      <LinkCard
        url={URL}
        title="Example Article"
        favicon="https://example.com/favicon.ico"
        siteName="Example"
        onOpen={vi.fn()}
        onDowngrade={vi.fn()}
      />,
    );
    const img = document.querySelector('.link-card__favicon') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain('favicon.ico');
    expect(screen.queryByText('Example Article')).not.toBeNull();
    expect(screen.queryByText(URL)).not.toBeNull();
    // no placeholder
    expect(document.querySelector('.link-card__favicon-placeholder')).toBeNull();
    expect(document.querySelector('.link-card__title--placeholder')).toBeNull();
  });
});

// ── LC-3: Error state ─────────────────────────────────────────────────────────

describe('LC-3 — error state', () => {
  it('shows favicon placeholder and URL as title fallback when error=true and no title', () => {
    render(
      <LinkCard url={URL} error onOpen={vi.fn()} onDowngrade={vi.fn()} />,
    );
    expect(document.querySelector('.link-card__favicon-placeholder')).not.toBeNull();
    // URL shown as the title (fallback)
    const titles = document.querySelectorAll('.link-card__title');
    const hasUrlAsTitle = Array.from(titles).some((el) => el.textContent === URL);
    expect(hasUrlAsTitle).toBe(true);
  });
});

// ── LC-4: Missing title fallback ──────────────────────────────────────────────

describe('LC-4 — missing title, not loading', () => {
  it('shows URL as the title when title prop is absent', () => {
    render(<LinkCard url={URL} onOpen={vi.fn()} onDowngrade={vi.fn()} />);
    const titleEl = document.querySelector('.link-card__title');
    expect(titleEl?.textContent).toBe(URL);
  });
});

// ── LC-5: onOpen callback ─────────────────────────────────────────────────────

describe('LC-5 — onOpen fires on card click', () => {
  it('calls onOpen when the card body div is clicked', () => {
    const onOpen = vi.fn();
    render(
      <LinkCard url={URL} title="Test" onOpen={onOpen} onDowngrade={vi.fn()} />,
    );
    const card = document.querySelector('.link-card') as HTMLElement;
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

// ── LC-6: onDowngrade — fires; does NOT trigger onOpen ───────────────────────

describe('LC-6 — onDowngrade fires; × click does NOT trigger onOpen', () => {
  it('calls onDowngrade and NOT onOpen when the × button is clicked', () => {
    const onOpen = vi.fn();
    const onDowngrade = vi.fn();
    render(
      <LinkCard url={URL} title="Test" onOpen={onOpen} onDowngrade={onDowngrade} />,
    );
    const xBtn = screen.getByRole('button', { name: /downgrade to plain link/i });
    fireEvent.click(xBtn);
    expect(onDowngrade).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
