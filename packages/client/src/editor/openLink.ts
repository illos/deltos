/**
 * Link click-to-open helpers (#69 links fix). An editor must NEVER window.open an arbitrary-scheme href —
 * `javascript:` / `data:` etc. are XSS vectors. Only http(s) + mailto are openable; everything else is
 * ignored. Pure + testable (the scheme filter is the secSys-relevant bit).
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Return the href IFF it's an absolute URL with a safe scheme (http/https/mailto), else null. Schemeless
 * or relative hrefs return null (don't open) — editor links are absolute; an unparseable href is not opened.
 */
export function safeLinkHref(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null; // relative / schemeless / malformed → don't open
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

/**
 * Normalize user-typed link input (#69 Deck link entry) into a safe href, or null to reject. A bare host
 * like "example.com" gets an https:// scheme (what a user means); anything already carrying a scheme is kept
 * and run through {@link safeLinkHref}, so unsafe schemes (javascript:, data:) are rejected. Empty → null.
 */
export function normalizeLinkInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A leading "scheme:" (RFC-3986-ish) means keep it; otherwise assume https.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  return safeLinkHref(hasScheme ? trimmed : `https://${trimmed}`);
}

/** Open a safe-scheme href in a new, isolated tab. Returns true iff it opened (caller preventDefaults). */
export function openLinkInNewTab(href: string | null | undefined): boolean {
  const safe = safeLinkHref(href);
  if (!safe) return false;
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}
