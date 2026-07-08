import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * ALL migration SQL, in filename order, read straight from `packages/worker/migrations/`. Test harnesses that
 * stand up an in-memory better-sqlite3 D1 shim apply this so their schema always matches the real DB — a new
 * `NNNN_*.sql` migration is picked up automatically, so adding one never silently breaks a harness whose
 * hardcoded list fell behind (the failure mode this replaces). Ordering is lexical over the zero-padded
 * `NNNN` prefix, which is the SAME order D1 applies them.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}
