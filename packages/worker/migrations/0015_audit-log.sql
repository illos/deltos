-- ROAD-0005 P3 — the USER-FACING audit projection. A queryable D1 mirror of the security-meaningful
-- subset of the audit trail, feeding the lazy "Account activity" Settings view (the live trust surface:
-- the owner can self-audit anytime and catch anomalous access as it happens, not just forensically).
--
-- This is a PROJECTION, not the source of truth. The tamper-proof forensic log is the append-only Workers
-- Analytics Engine dataset (audit.ts) — that one a compromised data path cannot wipe. THIS table lives in
-- the same `DB` the data layer can write, so it is intentionally the WEAKER, readable copy: convenient and
-- complete for the UI, while AE remains the immutable record for a real investigation. Accepted by design
-- (api-access-security-model.md §3 — "AE as truth, D1 projection for the user-facing view").
--
-- Only the security-meaningful subset is projected here (audit.ts decides): all `auth` lifecycle events
-- (login success/fail, token mint/revoke, session revoke), all `mcp`/agent access, and ANY denial — never
-- the owner's routine `rest`-allow sync chatter (that stays AE-only), so this table stays small + signal.
CREATE TABLE auditLog (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId     TEXT NOT NULL,  -- the account this event is scoped to; reads filter on it (BOLA-safe)
  ts            TEXT NOT NULL,  -- ISO-8601 server time of the event
  surface       TEXT NOT NULL,  -- 'rest' | 'mcp' | 'auth'
  action        TEXT NOT NULL,  -- the op / lifecycle action ('share', 'read', 'login', 'token.mint', …)
  result        TEXT NOT NULL,  -- 'allow' | 'deny'
  principalKind TEXT NOT NULL,  -- 'owner' | 'agent' | 'anonymous' | … (owner vs agent = the key signal)
  credentialRef TEXT,           -- the acting credential's grantId (NEVER a secret), null if unauthenticated
  resourceKind  TEXT,           -- 'workspace' | 'notebook' | 'note', when the event targets one
  resourceId    TEXT,           -- the specific resource id, when scoped
  ip            TEXT,           -- cf-connecting-ip at the time
  country       TEXT,           -- request.cf.country
  userAgent     TEXT,           -- the client UA string
  detail        TEXT            -- freeform: denial reason, MCP tool name, revoked grant/family id, …
);

-- Newest-first per account. id is monotonic (AUTOINCREMENT ~ insertion order), so ordering on it avoids a
-- string compare on ts while staying time-ordered. The view query is WHERE accountId = ? ORDER BY id DESC.
CREATE INDEX idx_auditLog_account ON auditLog (accountId, id DESC);
