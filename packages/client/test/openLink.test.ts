// @vitest-environment jsdom
/**
 * #69 links fix — scheme-safe click-to-open. The scheme filter is the secSys-relevant bit: an editor must
 * never window.open an arbitrary-scheme href (javascript:/data: = XSS). Only http(s)/mailto open.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeLinkHref, openLinkInNewTab, normalizeLinkInput } from '../src/editor/openLink.js';

afterEach(() => vi.restoreAllMocks());

describe('safeLinkHref — scheme allowlist', () => {
  it('allows http / https / mailto (absolute)', () => {
    expect(safeLinkHref('https://example.com')).toBe('https://example.com/');
    expect(safeLinkHref('http://example.com/path')).toBe('http://example.com/path');
    expect(safeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('rejects dangerous + non-web schemes', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,<script>1</script>')).toBeNull();
    expect(safeLinkHref('ftp://host/file')).toBeNull();
    expect(safeLinkHref('vbscript:msgbox')).toBeNull();
  });

  it('rejects schemeless / relative / empty / nullish (don\'t open)', () => {
    expect(safeLinkHref('example.com')).toBeNull();
    expect(safeLinkHref('/relative/path')).toBeNull();
    expect(safeLinkHref('')).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });
});

describe('normalizeLinkInput — user-typed link entry (Deck)', () => {
  it('prepends https:// to a bare host', () => {
    expect(normalizeLinkInput('example.com')).toBe('https://example.com/');
    expect(normalizeLinkInput('  example.com/path  ')).toBe('https://example.com/path');
  });

  it('keeps an explicit safe scheme', () => {
    expect(normalizeLinkInput('http://example.com')).toBe('http://example.com/');
    expect(normalizeLinkInput('https://example.com')).toBe('https://example.com/');
    expect(normalizeLinkInput('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('rejects an explicit UNSAFE scheme (no https-prepend rescue)', () => {
    expect(normalizeLinkInput('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkInput('data:text/html,x')).toBeNull();
  });

  it('rejects empty / whitespace', () => {
    expect(normalizeLinkInput('')).toBeNull();
    expect(normalizeLinkInput('   ')).toBeNull();
  });
});

describe('openLinkInNewTab', () => {
  it('opens a safe href in an isolated new tab and reports true', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openLinkInNewTab('https://example.com')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  it('does NOT open an unsafe-scheme href and reports false', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openLinkInNewTab('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
