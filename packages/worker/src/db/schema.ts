/**
 * D1 row types for the deltos schema. camelCase columns 1:1 with the spine (PIN-SUBSTRATE-1):
 * no camel↔snake mapping, no renaming layer. What is in the column is what crosses the edge.
 */

export interface NoteRow {
  id: string;
  notebookId: string;
  title: string;
  properties: string; // JSON-encoded PropertyBag
  body: string; // JSON-encoded Block[]
  version: number;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  deletedAt: string | null; // ISO-8601; null = live
  syncSeq: number; // monotonic pull-stream position (PIN-SYNC-2)
  forkedFromId: string | null; // set on conflict-copy / resurrection fork (PIN-SYNC-4)
}

/**
 * Thin abstraction over D1 and the better-sqlite3 test double. Production code calls
 * `d1Adapter(env.DB)`; tests call `sqliteAdapter(db)`. The SQL is identical — D1 is SQLite.
 *
 * Deliberately minimal: only the methods `mutate.ts` actually uses, so the test double stays
 * small and honest.
 */
export interface DbAdapter {
  /**
   * Run multiple statements atomically. Returns one result per statement.
   * In D1: `db.batch([...])`. In better-sqlite3: `db.transaction(...)()`.
   */
  batch(stmts: Array<{ sql: string; params: unknown[] }>): Promise<Array<{ rowsWritten: number }>>;

  /** Return the first matching row, or null. */
  first<T>(sql: string, params: unknown[]): Promise<T | null>;

  /** Return all matching rows. */
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/** Wraps a D1Database as a DbAdapter. */
export function d1Adapter(db: D1Database): DbAdapter {
  return {
    async batch(stmts) {
      const prepared = stmts.map((s) => db.prepare(s.sql).bind(...s.params));
      const results = await db.batch(prepared);
      return results.map((r) => ({ rowsWritten: r.meta.rows_written }));
    },
    async first<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).bind(...params).first<T>() as Promise<T | null>;
    },
    async all<T>(sql: string, params: unknown[]) {
      const r = await db.prepare(sql).bind(...params).all<T>();
      return r.results;
    },
  };
}
