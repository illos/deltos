import type { NoteResponse, NoteSummary } from '@deltos/shared';
import type { NoteRow } from './db/schema.js';

/**
 * Row → wire presenters, shared by the REST routes (index.ts) and the MCP tool adapter (routes/mcp.ts)
 * so both emit the IDENTICAL note shape from the same source. The server always returns
 * `syncStatus: 'synced'` — it is client-side-only state.
 */

/** Full note (REST note.get / MCP get_note). */
export function noteRowToResponse(row: NoteRow): NoteResponse {
  return {
    id: row.id as NoteResponse['id'],
    notebookId: row.notebookId as NoteResponse['notebookId'],
    title: row.title,
    properties: JSON.parse(row.properties) as NoteResponse['properties'],
    body: JSON.parse(row.body) as NoteResponse['body'],
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    syncStatus: 'synced',
  };
}

/** Search summary (REST note.search / MCP search_notes) — the title-bar fields, no body/properties. */
export function noteRowToSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id as NoteSummary['id'],
    notebookId: row.notebookId as NoteSummary['notebookId'],
    title: row.title,
    updatedAt: row.updatedAt,
    syncStatus: 'synced',
  };
}
