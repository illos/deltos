-- Auth pivot P0-belt (secSys cross-boot finding, planSys ruling — docs/specs/auth-pivot-password.md
-- @8ada7d9). The durable refresh cookie is set at FINALIZE (after phrase-ack), NOT at /signup, so an
-- abandoned registration never silently re-auths on next boot (suspenders). This column is the BELT:
-- a server-side flag, set TRUE at FINALIZE (the same ceremony-complete moment as the cookie), that
-- guarantees no account is left silently unrecoverable.
--
--   recoveryEstablished = 0  → the recovery phrase was generated but the user never completed the
--                              save-ack ceremony (e.g. an abandoned signup that set a password). On ANY
--                              successful login while this is 0, the flow FORCES the recovery-phrase
--                              screen (fresh phrase + verifier rotation) BEFORE entry, then sets it to 1.
--   recoveryEstablished = 1  → phrase-ack ceremony complete; the account is recoverable; login is normal.
--
-- ADD COLUMN with a NOT NULL DEFAULT 0 (SQLite allows this on ALTER) — additive over the committed 0004,
-- never editing an already-applied migration. No temp tables ([[migration-d1-no-temp-table]]).
ALTER TABLE passwordCredentials ADD COLUMN recoveryEstablished INTEGER NOT NULL DEFAULT 0
  CHECK (recoveryEstablished IN (0, 1));

INSERT INTO meta (key, value) VALUES ('passwordAuthSchemaVersion', '2')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
