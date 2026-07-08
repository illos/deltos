import { Hono } from 'hono';
import {
  SyncPushRequestSchema,
  SyncPullRequestSchema,
} from '@deltos/shared';
import type { SyncPushResult, NotebookPushResult, DictionaryPushResult, SyncNote, SyncNotebook, SyncDictionaryWord, NoteResponse } from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import { needsExtraction, type PropertyBag, type Block } from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, type AppContext } from '../http.js';
import { d1Adapter } from '../db/schema.js';
import type { NoteRow, NotebookRow, DictionaryWordRow } from '../db/schema.js';
import { insertNote, updateNote, pullSince } from '../db/mutate.js';
import { extractForNote } from '../extraction.js';
import { insertNotebook, renameNotebook, deleteNotebook } from '../db/notebooks.js';
import { addWord, removeWord } from '../db/dictionary.js';
import { requireAccountId } from '../db/accountScope.js';
import { createAuthStore } from '../db/authStore.js';
import { resolvedGrantFor, grantIsLive } from '../auth.js';
import { getActiveAlerts } from '../alerts.js';

// Sync is scoped to the ACCOUNT, not a notebook (Option B, 2026-06-18): the boundary is the caller's
// accountId, derived server-side from the bearer token (requireAccountId), never a client-supplied
// notebookId. The guard resource is therefore the workspace — the same resource the session grant is
// minted against (grantAllows: a workspace grant authorizes any resource), and a TYPED resource, not a
// bare id. notebookId survives only as a per-note organizing tag carried on each note.
const workspaceResource = (): Resource => ({ kind: 'workspace' });

const sync = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a NoteRow (DB wire) to the NoteResponse shape (parsed body/properties + syncStatus).
 * The server always returns `syncStatus: 'synced'` — that field is client-side-only state.
 */
function rowToResponse(row: NoteRow): NoteResponse {
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

function rowToSyncNote(row: NoteRow): SyncNote {
  return { ...rowToResponse(row), deletedAt: row.deletedAt ?? null, syncSeq: row.syncSeq };
}

/** NotebookRow (DB) → SyncNotebook (wire). */
function notebookRowToSync(row: NotebookRow): SyncNotebook {
  return {
    id: row.id as SyncNotebook['id'],
    name: row.name,
    defaultCollectionView: row.defaultCollectionView,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
    syncSeq: row.syncSeq,
  };
}

/** DictionaryWordRow (DB) → SyncDictionaryWord (wire). */
function dictionaryRowToSync(row: DictionaryWordRow): SyncDictionaryWord {
  return {
    word: row.word,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
    syncSeq: row.syncSeq,
  };
}

/** NotebookRow → the conflict-result serverNotebook shape (notebook + version, no sync fields). */
function notebookConflictRow(row: NotebookRow): NonNullable<Extract<NotebookPushResult, { outcome: 'conflict' }>['serverNotebook']> {
  return {
    id: row.id as SyncNotebook['id'],
    name: row.name,
    defaultCollectionView: row.defaultCollectionView,
    version: row.version,
  };
}

/**
 * ROAD-0014: after an accepted note upsert, kick off FILE-CONTENT extraction (digital-PDF text / image OCR)
 * OUT OF BAND via `waitUntil` so it never fails or slows the push response. Cheap-gated: only file notes with
 * an extractable, not-yet-extracted attachment schedule work ({@link needsExtraction}); everything else is a
 * no-op. The extractor re-checks the predicate under a fresh read, so a lost waitUntil is caught by the cron.
 *
 * `executionCtx.waitUntil` is unavailable in the unit-test harness (`app.request` without an ExecutionContext)
 * — there it throws, so we fall back to letting the promise run detached (harmless: test notes aren't file
 * notes, and the extractor no-ops without BLOBS anyway).
 */
function scheduleExtraction(c: AppContext, accountId: string, row: NoteRow): void {
  if (!c.env.BLOBS) return;
  let properties: PropertyBag;
  let body: Block[];
  try {
    properties = JSON.parse(row.properties) as PropertyBag;
    body = JSON.parse(row.body) as Block[];
  } catch {
    return;
  }
  if (!needsExtraction({ properties, body })) return;
  const task = extractForNote(c.env, accountId, row.id).catch((err) =>
    console.error(`extraction: waitUntil failed for note ${row.id}`, err),
  );
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

// ---------------------------------------------------------------------------
// POST /api/sync/push  (PIN-SYNC-1)
// ---------------------------------------------------------------------------

sync.post(
  '/push',
  guard({
    op: 'write',
    schema: SyncPushRequestSchema,
    input: async (c) => {
      try { return await c.req.json(); } catch { return undefined; }
    },
    resource: workspaceResource,
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      // accountId is the caller's verified account (principal.id post-D6 re-point), resolved
      // server-side off the guard-set principal — NEVER from the request body. It scopes every write
      // to this account: insert STAMPS it, update CAS + conflict-path SELECT filter on it (no
      // cross-account write or leak). Fail-closed: requireAccountId throws if absent.
      const accountId = requireAccountId(c);
      const now = new Date().toISOString();
      const results: SyncPushResult[] = [];
      const notebookResults: NotebookPushResult[] = [];
      const dictionaryResults: DictionaryPushResult[] = [];

      // NOTEBOOKS FIRST (secSys gate #19 / #23 ordering): a same-batch "create notebook then move a note
      // into it" must see the notebook already exist when the note move's target-ownership check runs.
      // create (baseVersion 0) / rename (baseVersion N) / delete (delete:true → tombstone + cascade live
      // notes to Trash). Same accountId scope + accountSyncSeq stream as notes.
      for (const nb of req.notebookEntries) {
        const outcome = nb.delete === true
          ? await deleteNotebook(db, nb, accountId, now)
          : nb.baseVersion === 0
            ? await insertNotebook(db, nb, accountId, now)
            : await renameNotebook(db, nb, accountId, now);
        if (outcome.outcome === 'accepted') {
          notebookResults.push({ id: nb.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
        } else {
          notebookResults.push({
            id: nb.id,
            outcome: 'conflict',
            serverNotebook: outcome.serverRow ? notebookConflictRow(outcome.serverRow) : null,
            reason: outcome.reason,
          });
        }
      }

      // NOTES — each entry carries its own notebookId (Option B; stamped on insert, restamped on a
      // move, ownership-checked). accountId is server-derived and scopes every write + conflict SELECT.
      for (const entry of req.entries) {
        if (entry.baseVersion === 0) {
          // INSERT notebookId (#58 tri-state): an explicit per-entry value (id OR null) wins; if omitted,
          // fall to the batch-level "current notebook"; if neither, NULL = uncategorized (All Notes). A
          // note no longer requires a notebook — there is no default to fall back on.
          const notebookId = entry.notebookId !== undefined ? entry.notebookId : (req.notebookId ?? null);
          const outcome = await insertNote(db, { ...entry, notebookId }, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
            scheduleExtraction(c, accountId, outcome.row);
          } else {
            results.push({ id: entry.id, outcome: 'conflict', serverNote: null });
          }
        } else {
          const outcome = await updateNote(db, entry, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
            scheduleExtraction(c, accountId, outcome.row);
          } else {
            const serverNote = outcome.serverRow ? rowToResponse(outcome.serverRow) : null;
            results.push({ id: entry.id, outcome: 'conflict', serverNote });
          }
        }
      }

      // CUSTOM DICTIONARY (§5.2) — set semantics, conflict-free: add (upsert, clears tombstone) or remove
      // (tombstone). accountId scopes every write; the word is the account-scoped identity. Always accepted.
      for (const dict of req.dictionaryEntries) {
        const outcome = dict.delete === true
          ? await removeWord(db, accountId, dict.word, now)
          : await addWord(db, accountId, dict.word, now);
        dictionaryResults.push({ word: outcome.word, outcome: 'accepted', syncSeq: outcome.syncSeq });
      }

      return c.json({ results, notebookResults, dictionaryResults });
    },
  }),
);

// ---------------------------------------------------------------------------
// GET /api/sync/pull  (PIN-SYNC-2)
// ---------------------------------------------------------------------------

sync.get(
  '/pull',
  guard({
    op: 'read',
    schema: SyncPullRequestSchema,
    input: (c) => {
      const cursorRaw = c.req.query('cursor');
      const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;
      return { cursor };
    },
    resource: workspaceResource,
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      // Read isolation: pull returns ONLY the caller's account's notes (accountId resolved server-side
      // off the principal, never the body), across every notebookId the account owns. Fail-closed if
      // absent.
      const accountId = requireAccountId(c);
      const { notes, notebooks, dictionaryWords, nextCursor, hasMore } = await pullSince(db, accountId, req.cursor);
      // ALERT PROJECTION (alert-banner-system.md §4.1) — computed FRESH each pull, OUTSIDE the cursor window
      // (does not advance nextCursor / touch the syncSeq stream). Scoped to the REQUESTING token so agent
      // write-approval asks surface only to the token that raised them. Read off the guard-set principal (the
      // same live-grant representative the MCP transport uses); a session/legacy row with no group → null.
      const principal = c.get('principal')!;
      const nowMs = Date.now();
      const liveGrant = (resolvedGrantFor(principal) ?? []).find((g) => grantIsLive(g, nowMs));
      const tokenGroupId = liveGrant?.tokenGroupId ?? liveGrant?.grantId ?? null;
      const store = createAuthStore(db);
      const activeAlerts = await getActiveAlerts(store, accountId, tokenGroupId, nowMs);
      return c.json({
        notes: notes.map(rowToSyncNote),
        notebooks: notebooks.map(notebookRowToSync),
        dictionaryWords: dictionaryWords.map(dictionaryRowToSync),
        alerts: activeAlerts,
        nextCursor,
        hasMore,
      });
    },
  }),
);

export { sync };
