-- Note routing guide (2026-07-02) — a user-scoped freeform text setting the owner edits, surfaced to the
-- MCP agent (via list_notebooks) so saved conversations/notes are filed into the right notebook
-- consistently. Account-scoped, nullable, NO server-side processing (plain text/markdown, ~8KB soft cap
-- enforced at the API boundary). Owner-only to edit (GET/PUT gated op:'share'); agent-readable via
-- list_notebooks. A NULL guide = unset (the agent falls back to asking, else All Notes).
ALTER TABLE accounts ADD COLUMN noteRoutingGuide TEXT;
