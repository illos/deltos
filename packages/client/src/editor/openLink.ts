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

/** Open a safe-scheme href in a new, isolated tab. Returns true iff it opened (caller preventDefaults). */
export function openLinkInNewTab(href: string | null | undefined): boolean {
  const safe = safeLinkHref(href);
  if (!safe) return false;
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}
