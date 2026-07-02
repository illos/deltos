/**
 * Plugin-declared AGENT TOOLING seam (firm design directive, Jim) — a plugin DECLARES its own MCP tool
 * surface (wire-facing name/description/inputSchema + the model-facing usage guidance), and the worker's MCP
 * server AGGREGATES those declarations instead of hardcoding per-plugin tool text inline.
 *
 * RESIDENCY: this lives in @deltos/shared, NOT the worker and NOT the client `PluginManifest`. The manifest
 * lives in the client chunk and the worker cannot import client code, so the declarative half of a plugin's
 * agent tooling is hoisted here where BOTH sides can reference it. The worker binds each declaration to its
 * runtime handler (the zod `argsSchema` + `execute`, which need `db`/`storeBlob`/`env` and therefore stay in
 * the worker); this module carries ONLY the wire-shape + prose, so it adds zero runtime weight to the client.
 *
 * The `inputSchema` is the JSON-Schema object advertised verbatim in `tools/list` (matching the shape the
 * existing MCP_TOOLS entries hand-author), so aggregating through this seam leaves the wire protocol byte-for-
 * byte unchanged. The zod schema at the worker boundary remains the validation source of truth (schema-first).
 */

/** One plugin-declared agent tool: the wire surface + optional model-facing usage guidance. */
export interface AgentToolDef {
  /** The tool name advertised in `tools/list` and dispatched by `tools/call`. */
  name: string;
  /** The rich, model-facing description advertised in `tools/list` (server-resident — free to be detailed). */
  description: string;
  /** The JSON-Schema object advertised in `tools/list` (mirrors the worker-side zod `argsSchema`). */
  inputSchema: Record<string, unknown>;
  /**
   * Optional usage guidance folded into the `initialize` instructions — WRITE-SCOPE ONLY (these are write
   * tools; a read-only connection never sees them). Teaches the model when/how to reach for the tool.
   */
  instructions?: string;
}

/** Shared prose for the base64/size contract, reused by both files tools' descriptions. */
const FILE_BYTES_DESC =
  'The raw file bytes, base64-encoded (standard base64 — NOT a data: URL and NOT url-safe base64). ' +
  'The decoded file must be at most ~6 MB; larger files are rejected.';

const FILENAME_DESC =
  'The file name including its extension, e.g. "budget.pdf" or "diagram.png". Used as the display name.';

const MIME_DESC =
  'The IANA media type of the file, e.g. "application/pdf", "image/png", "image/jpeg". A well-formed ' +
  '"type/subtype" is required. An image type renders inline; any other type shows as a download chip.';

/**
 * The files / attachment plugin's agent tooling — the FIRST consumer of the seam. Both tools ride the SAME
 * `attachment` block (`{ hash, name, mime, size }`): `create_file_note` makes a whole file-note (title =
 * filename, one attachment block), `embed_file` appends one attachment block to an existing note. Image vs
 * download-chip is a client render branch on `mime`, so this one declaration covers file-notes, file embeds,
 * and image embeds alike.
 */
export const FILES_AGENT_TOOLS: readonly AgentToolDef[] = [
  {
    name: 'create_file_note',
    description:
      'Create a NEW file-note from raw file bytes — a note whose content IS a stored file (a PDF, an image, ' +
      'a document, …). Applies immediately. The server stores the bytes (content-addressed) and mints a note ' +
      'whose title is the filename and whose body is the single file/image. Use this to save a file the user ' +
      'gave you into their notes. For an image the note renders the picture; for any other file it renders a ' +
      'download chip. Optionally pass a notebookId (from list_notebooks) to file it; omit it for "All Notes". ' +
      'Returns the created note. Recoverable via trash_note.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: FILENAME_DESC },
        mime: { type: 'string', description: MIME_DESC },
        content_base64: { type: 'string', description: FILE_BYTES_DESC },
        notebookId: {
          type: 'string',
          description: 'Optional notebook id (from list_notebooks) to file the file-note under.',
        },
      },
      required: ['filename', 'mime', 'content_base64'],
      additionalProperties: false,
    },
    instructions:
      '- create_file_note saves raw file/image bytes AS a new note (title = filename, body = the file). ' +
      'embed_file adds a file/image to the END of an EXISTING note (like append_block, but for a file). ' +
      'For both, pass the bytes base64-encoded (standard base64, ≤ ~6 MB decoded) with the real filename + ' +
      'mime; images render inline, other files as a download chip. Only send files the user actually gave you.',
  },
  {
    name: 'embed_file',
    description:
      'Embed a file or image INTO an existing note by appending it to the end, without touching the existing ' +
      'content (note id from search_notes or list_notebooks). Applies immediately. The server stores the ' +
      'bytes (content-addressed) and appends one file/image block. An image renders inline; any other file ' +
      'renders a download chip. Use this to attach a file to a note the user is working on; use ' +
      'create_file_note to make a standalone file-note instead. If the note was modified concurrently the ' +
      'call reports a conflict — re-read and retry.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: 'The id of the existing note to embed the file into (from search_notes or list_notebooks).',
        },
        filename: { type: 'string', description: FILENAME_DESC },
        mime: { type: 'string', description: MIME_DESC },
        content_base64: { type: 'string', description: FILE_BYTES_DESC },
      },
      required: ['note_id', 'filename', 'mime', 'content_base64'],
      additionalProperties: false,
    },
    // Usage guidance is authored ONCE on create_file_note above (it covers both tools) to avoid repeating it.
  },
];

/**
 * The aggregate registry the worker reads to build its tool list + instructions. Today it is exactly the
 * files plugin; a future plugin appends its own `AgentToolDef[]` here (or the worker spreads several arrays),
 * and the tool surface + guidance pick it up with no per-plugin branching in the MCP server.
 */
export const PLUGIN_AGENT_TOOLS: readonly AgentToolDef[] = [...FILES_AGENT_TOOLS];

/** Look up a plugin-declared agent tool by name (the worker pairs it with a local argsSchema + execute). */
export function findAgentToolDef(name: string): AgentToolDef | undefined {
  return PLUGIN_AGENT_TOOLS.find((t) => t.name === name);
}

/**
 * The aggregated, write-scope-only usage guidance — every plugin tool's `instructions`, joined. The worker
 * folds this into `mcpInstructions()` for a write-capable connection; a read-only connection never receives
 * it (nor the tools). Empty string when no plugin declares guidance.
 */
export function agentToolInstructions(): string {
  return PLUGIN_AGENT_TOOLS.map((t) => t.instructions)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n');
}
