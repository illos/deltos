-- 0023 — AGENT BULK-WRITE APPROVAL (alert-banner-system.md §6.2): a durable, TOKEN-SCOPED pending-approval
-- record. An agent that trips the low daily mcpWrite cap (100/account/day, an injection blast-radius guard)
-- can only ASK for headroom via `request_write_approval`; the human sees scale+intent and Approves/Denies
-- in-app. Approval is a quota-LIFT (writes still apply live), NOT a proposal queue.
--
-- SCOPING: `tokenGroupId` is the REQUESTING token (stable across per-resource revocation — the same key the
-- MCP rate-limit + audit already use), so approving token A's import never lifts token B's cap. `accountId`
-- is the server-derived owner (BOLA read/act filter). The lift is COUNT-boxed (`grantedCount`) AND TIME-boxed
-- (`windowDayBucket` pins it to one UTC day → auto-reverts to 100 with no cleanup job). Pending requests
-- self-expire at `expiresAt` (createdAt + 30 min).
--
-- A NEW migration number (0022 was the highest applied — never rewrite an applied file,
-- [[migration-never-rewrite-applied]]). No CREATE TEMP TABLE (D1's authorizer rejects it,
-- [[migration-d1-no-temp-table]]).
CREATE TABLE agentWriteApprovals (
  id             TEXT PRIMARY KEY,                 -- server-minted uuid; the alert.targetId + action target
  accountId      TEXT NOT NULL,                    -- owner account (server-derived; BOLA read/act filter key)
  tokenGroupId   TEXT NOT NULL,                    -- the REQUESTING token (grant-set id) — approval is token-scoped
  requestedCount INTEGER NOT NULL,                 -- how many extra writes the agent asked for (~430)
  reason         TEXT NOT NULL,                    -- agent-supplied intent, shown to the human (capped length)
  status         TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied' | 'expired'
  grantedCount   INTEGER,                          -- extra writes actually granted (== requestedCount on approve)
  approvedAt     INTEGER,                          -- ms epoch of approval (null until approved)
  windowDayBucket TEXT,                            -- the UTC day ('YYYY-MM-DD') the extra applies to (time-box)
  createdAt      INTEGER NOT NULL,                 -- ms epoch of the request
  expiresAt      INTEGER NOT NULL                  -- ms epoch a pending request self-expires (createdAt + 30 min)
);

-- Account-scoped pending lookup (the sync-pull projection + the BOLA REST reads/acts).
CREATE INDEX idx_agentWriteApprovals_account ON agentWriteApprovals (accountId, status);
-- Token-scoped active-grant lookup (effectiveWriteCap: SUM approved grants for this token on this day).
CREATE INDEX idx_agentWriteApprovals_token ON agentWriteApprovals (tokenGroupId, status, windowDayBucket);
