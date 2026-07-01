import { describe, it, expect } from 'vitest';
import {
  matchRedirectUri,
  loopbackIdentity,
  isRegisterableRedirectUri,
  pkceChallengeFromVerifier,
  verifyPkceS256,
} from '../src/oauth.js';

/**
 * The two load-bearing OAuth security controls (docs/design/oauth-provider.md §4): exact redirect-uri
 * matching (with the RFC 8252 loopback port-exception) and PKCE S256. A hole in either defeats the whole
 * provider (open redirect → code theft; PKCE bypass → code-interception), so they are pinned here.
 */

describe('matchRedirectUri — the anti-phishing allow-list', () => {
  it('accepts an exact https match and nothing near it', () => {
    const reg = ['https://claude.ai/api/mcp/callback'];
    expect(matchRedirectUri('https://claude.ai/api/mcp/callback', reg)).toBe(true);
    // no prefix / substring / trailing-slash / subdomain slack
    expect(matchRedirectUri('https://claude.ai/api/mcp/callback/', reg)).toBe(false);
    expect(matchRedirectUri('https://claude.ai/api/mcp/callback?x=1', reg)).toBe(false);
    expect(matchRedirectUri('https://claude.ai.evil.com/api/mcp/callback', reg)).toBe(false);
    expect(matchRedirectUri('https://evil.com/api/mcp/callback', reg)).toBe(false);
  });

  it('loopback matches on scheme+host+path but ANY port (native ephemeral port)', () => {
    const reg = ['http://127.0.0.1/callback'];
    expect(matchRedirectUri('http://127.0.0.1:51763/callback', reg)).toBe(true);
    expect(matchRedirectUri('http://127.0.0.1:8080/callback', reg)).toBe(true);
    expect(matchRedirectUri('http://127.0.0.1/callback', reg)).toBe(true);
    // path still must match; host still must be loopback
    expect(matchRedirectUri('http://127.0.0.1:51763/other', reg)).toBe(false);
    expect(matchRedirectUri('http://localhost:51763/callback', reg)).toBe(false); // localhost != 127.0.0.1
    expect(matchRedirectUri('http://evil.com:51763/callback', reg)).toBe(false);
  });

  it('ipv6 loopback is recognized', () => {
    const reg = ['http://[::1]/cb'];
    expect(matchRedirectUri('http://[::1]:5000/cb', reg)).toBe(true);
    expect(matchRedirectUri('http://[::1]:6000/cb', reg)).toBe(true);
    expect(matchRedirectUri('http://[::1]:5000/nope', reg)).toBe(false);
  });

  it('does NOT grant the loopback port-exception to a non-loopback host', () => {
    // A registered non-loopback http (which should never be registerable) must not port-flex.
    expect(matchRedirectUri('http://evil.com:9999/cb', ['http://evil.com/cb'])).toBe(false);
  });

  it('is fail-closed on garbage input', () => {
    expect(matchRedirectUri('not a url', ['https://claude.ai/cb'])).toBe(false);
    expect(matchRedirectUri('https://claude.ai/cb', [])).toBe(false);
  });

  it('loopbackIdentity strips the port and rejects non-loopback / non-http', () => {
    expect(loopbackIdentity('http://127.0.0.1:1234/cb')).toEqual({
      scheme: 'http:',
      host: '127.0.0.1',
      path: '/cb',
    });
    expect(loopbackIdentity('https://127.0.0.1/cb')).toBeNull(); // loopback exception is http-only
    expect(loopbackIdentity('http://example.com/cb')).toBeNull();
  });
});

describe('isRegisterableRedirectUri — what may be registered', () => {
  it('allows https and http-loopback, refuses plaintext to a real host', () => {
    expect(isRegisterableRedirectUri('https://claude.ai/cb')).toBe(true);
    expect(isRegisterableRedirectUri('http://127.0.0.1/cb')).toBe(true);
    expect(isRegisterableRedirectUri('http://[::1]:0/cb')).toBe(true);
    expect(isRegisterableRedirectUri('http://evil.com/cb')).toBe(false); // would leak code over plaintext
    expect(isRegisterableRedirectUri('ftp://x/cb')).toBe(false);
    expect(isRegisterableRedirectUri('garbage')).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('accepts the correct verifier and rejects a wrong one', () => {
    // Canonical RFC 7636 Appendix B vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(pkceChallengeFromVerifier(verifier)).toBe(challenge);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('the-wrong-verifier-value-padding-to-len-4x', challenge)).toBe(false);
    expect(verifyPkceS256(verifier, 'tampered-challenge')).toBe(false);
  });
});
