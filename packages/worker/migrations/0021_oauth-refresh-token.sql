-- OAuth 2.1 rotating refresh tokens (oauth-provider.md §5 "v1-rotating" follow-up). The authorization-code
-- exchange now issues a SHORT-lived access token (1h) paired with a rotating refresh token; the refresh
-- grant rotates it (new access + new refresh in the SAME family) and reusing a spent/revoked refresh nukes
-- the whole family (theft detection) — mirroring the password-auth refreshSessions machinery (migration 0004
-- + the 0014 grants.familyId family link).
--
-- Why a DEDICATED table (not refreshSessions):
--   * refreshSessions is cookie/device-shaped — it carries a device `label` and IS the source for the
--     password "Active sessions" management UI (listRefreshSessionsForAccount). OAuth refresh tokens are
--     client-held bearer strings that must NEVER surface as user "sessions".
--   * An OAuth refresh must carry the client/scope/resource BINDING needed to re-mint the access grant on
--     rotation WITHOUT trusting a re-read of mutable grant rows — so it stores clientId + scope + resources
--     + the RFC-8707 audience, self-contained. `familyId` is the SAME id space as grants.familyId (0014):
--     the OAuth access grant set is minted carrying this familyId, so a family-nuke revokes BOTH the refresh
--     rows AND the outstanding access grants in one batch.
--   * The ACCESS side needs no schema change — grants.familyId (0014) already links access grants to a
--     family, and OAuth agent grants carry it (the "sign out other sessions" sweep is owner-filtered, and
--     OAuth families are distinct random ids, so it can never touch them).
--
-- Only the SHA-256 HASH of the refresh token is stored (F6) — never the raw token. Additive + inert until
-- the /token route is wired to write/read it; no existing row or path changes.
CREATE TABLE oauthRefreshToken (
  tokenHash   TEXT    NOT NULL PRIMARY KEY,  -- base64url(SHA-256(refreshToken)) — F6, never the raw token
  familyId    TEXT    NOT NULL,              -- rotation family; SAME id space as grants.familyId (0014)
  clientId    TEXT    NOT NULL,              -- -> oauthClient.clientId; per-client disconnect keys on this
  accountId   TEXT    NOT NULL,              -- -> accounts.accountId (the owning account)
  scope       TEXT    NOT NULL,              -- JSON string[] — the CLAMPED consent scope, carried unchanged
  resources   TEXT    NOT NULL,              -- JSON Resource[] — the approved resource set, carried unchanged
  resource    TEXT,                          -- RFC-8707 audience url (nullable), carried unchanged
  issuedAtMs  INTEGER NOT NULL,              -- epoch-millis, audit
  expiresAtMs INTEGER NOT NULL,              -- epoch-millis — the durable (sliding) refresh window
  rotatedAt   TEXT,                          -- ISO-8601 Z; presence = spent by a rotation (successor exists)
  revokedAt   TEXT                           -- ISO-8601 Z; presence = revoked (family-nuke / disconnect / revoke-all)
);

-- Family-nuke (theft detection) + rotation both scan by family.
CREATE INDEX oauthRefreshToken_byFamily ON oauthRefreshToken(familyId);
-- Per-client disconnect (DELETE /api/oauth/clients/:clientId) revokes this account's refresh rows for a client.
CREATE INDEX oauthRefreshToken_byClientAccount ON oauthRefreshToken(clientId, accountId);
-- Revoke-all (credential-change) sweeps every refresh row for an account.
CREATE INDEX oauthRefreshToken_byAccount ON oauthRefreshToken(accountId);
