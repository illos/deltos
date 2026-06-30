/**
 * deviceLabel — a coarse, dependency-free "Safari on iPhone" label derived from the request User-Agent,
 * captured at fresh-device login and carried forward across rotations so the "Active sessions" Settings
 * list can show the user which device each session is. It is COSMETIC: it never gates a `can()` decision,
 * is stored only on the refresh-session row (never re-derived as authority), and a missing/unparseable UA
 * degrades gracefully to "Unknown device" (null only when there is no UA header at all).
 *
 * Deliberately tiny and heuristic — NOT a full UA-parser library (that would add bundle + a parsing
 * attack surface for zero security value). It only needs to be good enough to tell the user's own phone
 * from their laptop. Order matters: the browser check runs most-specific-first (Edge/Opera before Chrome,
 * because they embed "Chrome" in their UA), and the OS check runs iOS/Android before the desktop families.
 */

type Match = { needle: RegExp; name: string };

// Browser families, most-specific first. Edge ("Edg/") and Opera ("OPR/") MUST precede Chrome — both
// carry "Chrome" in their UA — and Chrome must precede Safari for the same embedding reason.
const BROWSERS: Match[] = [
  { needle: /\bEdg(?:e|A|iOS)?\//i, name: 'Edge' },
  { needle: /\bOPR\/|\bOpera\b/i, name: 'Opera' },
  { needle: /\bFirefox\/|\bFxiOS\//i, name: 'Firefox' },
  { needle: /\bChrome\/|\bCriOS\//i, name: 'Chrome' },
  { needle: /\bSafari\//i, name: 'Safari' },
];

// OS / device families, most-specific first. iPadOS Safari masquerades as "Macintosh", but a touch iPad
// reports "iPad"; iPhone/iPod report their own tokens — so the mobile-Apple checks precede macOS.
const PLATFORMS: Match[] = [
  { needle: /\biPhone\b/i, name: 'iPhone' },
  { needle: /\biPad\b/i, name: 'iPad' },
  { needle: /\biPod\b/i, name: 'iPod' },
  { needle: /\bAndroid\b/i, name: 'Android' },
  { needle: /\bWindows\b/i, name: 'Windows' },
  { needle: /\bMac OS X\b|\bMacintosh\b/i, name: 'macOS' },
  { needle: /\bCrOS\b/i, name: 'ChromeOS' },
  { needle: /\bLinux\b/i, name: 'Linux' },
];

function firstMatch(ua: string, table: Match[]): string | null {
  for (const { needle, name } of table) {
    if (needle.test(ua)) return name;
  }
  return null;
}

/**
 * Produce a coarse "<Browser> on <Platform>" label from a User-Agent, e.g. "Safari on iPhone",
 * "Chrome on macOS", "Firefox on Windows". Returns:
 *   - `null` when there is NO user-agent header (nothing to label),
 *   - "Unknown device" when a UA is present but neither browser nor platform is recognized,
 *   - "<Browser>" or "on <Platform>" when only one half is recognized (still useful to the user).
 */
export function deviceLabelFromUA(ua: string | undefined): string | null {
  if (ua === undefined || ua.trim() === '') return null;
  const browser = firstMatch(ua, BROWSERS);
  const platform = firstMatch(ua, PLATFORMS);
  if (!browser && !platform) return 'Unknown device';
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  return `on ${platform!}`;
}
