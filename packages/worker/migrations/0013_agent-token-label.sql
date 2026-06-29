-- Agent-token labels (llm-mcp-integration.md §5). The agent credential is NOT a new table — it is an
-- existing `grants` row with principalKind='agent' (already in the 0002 schema comment + the shared Zod
-- enum), non-expiring, scope-clamped read-only. The ONE thing the grants table can't already hold is a
-- human-friendly label ("Claude Desktop", "phone connector") for the Settings revoke list, so add it.
--
-- NULLABLE + COSMETIC: label carries no authority — it never gates a `can()` decision, is server-stored
-- but client-supplied, and is absent on every pre-existing grant (owner sessions, share links). A new
-- migration number (never a rewrite of an applied file): 0002_stream-a-auth.sql is long-since applied.
--
-- STRUCTURAL ONLY: adds one nullable column. Mutates no rows, crosses no account boundary, touches no
-- existing grant. Owner/device/capability grants simply leave it NULL.

ALTER TABLE grants ADD COLUMN label TEXT;
