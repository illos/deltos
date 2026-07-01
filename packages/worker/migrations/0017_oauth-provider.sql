-- ROAD-0005 (first capability) — OAuth 2.1 provider: deltos becomes the Authorization Server for its own
-- MCP resource (`/api/mcp`). See docs/design/oauth-provider.md. This migration is the INERT foundation:
-- it lands the storage the endpoints (discovery / DCR / authorize / token) build on, but wires NO route, so
-- deploying it alone changes no behavior. Additive-only (the 0013/0014 pattern) — no existing row moves.
--
-- Decisions baked in (authorization-model.md §2a, Jim 2026-06-30/07-01):
--   * client identity = a `clientId` COLUMN on `grants` (NOT a new principalKind) → an OAuth access token IS
--     an `agent` grant carrying a clientId, so the H3 revoke-all sweep (WHERE principalKind IN
--     ('owner','agent')) covers it BY CONSTRUCTION, while `WHERE clientId=?` gives per-client revoke.
--   * v1 tokens are NON-EXPIRING, no refresh token (keeps the standing no-TTL stance; revoke is the control).

-- Registered OAuth clients (RFC 7591 Dynamic Client Registration records). PUBLIC PKCE clients only, so
-- there is NO client_secret column — the PKCE code_verifier is the proof at /token, never a shared secret.
-- Registration grants ZERO access on its own; access exists only after the logged-in owner completes the
-- /authorize consent. So this table is low-stakes (spam = rows) — /register is rate-limited + old unused
-- clients are cron-pruned. `redirectUris` is the load-bearing anti-phishing field: a code/token is only ever
-- delivered to a redirect_uri that EXACT-matches one stored here (loopback port-exception per RFC 8252).
CREATE TABLE oauthClient (
  clientId     TEXT PRIMARY KEY,   -- issued at registration; random, opaque; the public client identifier
  clientName   TEXT NOT NULL,      -- human label shown on the consent screen (from DCR client_name)
  redirectUris TEXT NOT NULL,      -- JSON string[] of registered redirect URIs; exact-match allow-list
  softwareId   TEXT,               -- optional DCR software_id (client family, e.g. the MCP client build)
  metadata     TEXT,               -- optional JSON blob of remaining DCR metadata (non-authoritative)
  createdAt    TEXT NOT NULL       -- ISO-8601 Z
);

-- Authorization codes (RFC 6749 §4.1 + PKCE). A code is SHORT-LIVED (~60s), SINGLE-USE, and fully bound to
-- the client / account / redirect / PKCE challenge / scope it was issued under — so it can only be redeemed
-- by the party that started the flow, once, at the registered redirect. Only the SHA-256 hash is stored
-- (mirrors grants.tokenHash, F6) — the raw code lives only in the 302 back to the client. Reaped by the
-- scheduled() cron alongside the other D1 mirrors; the 60s TTL means at most a trickle is ever live.
CREATE TABLE oauthAuthCode (
  codeHash      TEXT PRIMARY KEY,  -- base64url(SHA-256(rawCode)); the raw code is never persisted
  clientId      TEXT NOT NULL,     -- the client this code was issued to (must match at /token)
  accountId     TEXT NOT NULL,     -- the consenting owner's accountId (server-derived at /authorize; the grant's principalId)
  redirectUri   TEXT NOT NULL,     -- the exact redirect_uri consent was granted for (must match at /token)
  codeChallenge TEXT NOT NULL,     -- PKCE S256 challenge; /token recomputes BASE64URL(SHA256(verifier)) and compares
  scope         TEXT NOT NULL,     -- JSON Scope[]; clamped read-only ['read','search'] at issuance
  resource      TEXT,              -- RFC 8707 audience (…/api/mcp); recorded so the binding survives a 2nd RS
  expiresAtMs   INTEGER NOT NULL,  -- epoch-millis; numeric instant compare, never lexical
  consumedAt    TEXT,              -- ISO-8601 Z; the single-use latch — set on first /token redemption, replay denied
  createdAt     TEXT NOT NULL      -- ISO-8601 Z
);

-- The client-identity axis on the canonical ACL. NULL = a first-party token (Settings-minted agent token or
-- an owner session grant); a set value = an OAuth-issued token, FK-ish to oauthClient.clientId. Nullable +
-- additive so every existing grant row is untouched (reads as a first-party NULL). Per-client revoke and the
-- Connected-apps list both key on this column; the H3 revoke-all sweep ignores it (still keys on principalKind).
ALTER TABLE grants ADD COLUMN clientId TEXT;

-- Per-client revoke + the Connected-apps listing scan grants by clientId; index it so neither is a full scan.
CREATE INDEX grants_byClientId ON grants (clientId);
