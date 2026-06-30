/**
 * SEPARATION-OF-DUTIES invariant for the P3 security audit log (ROAD-0005 §3, P5 red-team scoreboard).
 *
 * The whole tamper-resistance argument rests on ONE structural fact: the `AUDIT` binding is reachable ONLY
 * through the request context (`c.env.AUDIT`, read solely in `audit.ts`). The data layer — `db/*`,
 * `mutate.ts`, and the MCP tool `execute` functions — takes its `DbAdapter` by ARGUMENT and never touches
 * `c.env`, so a fully-compromised data path has no handle to the audit log and cannot rewrite history.
 *
 * This test FAILS if any data-layer source file gains a reference to the AUDIT binding — i.e. if someone
 * accidentally (or maliciously) plumbs the audit handle into a place that could erase its own trail. It is
 * the executable form of "attack the audit log with a write token" → must be structurally impossible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '../src');

/** Every .ts file under a directory, recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('P3 audit — separation of duties (the audit handle is withheld from the data layer)', () => {
  it('the AUDIT binding is referenced ONLY in audit.ts and the env declaration — never the data layer', () => {
    // The ONLY files allowed to name the AUDIT binding: the helper that owns it + the binding declaration.
    // The chokepoints/lifecycle handlers call `audit(c, …)` (the helper) — they never touch `c.env.AUDIT`.
    const ALLOWED = new Set(['audit.ts', 'env.ts']);
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const base = file.slice(SRC.length + 1);
      if (ALLOWED.has(base)) continue;
      const text = readFileSync(file, 'utf8');
      // Match the binding handle specifically (`.AUDIT` / `env.AUDIT`), not the `audit(` helper calls.
      if (/\bc\.env\.AUDIT\b|\benv\.AUDIT\b|\.AUDIT\b/.test(text)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });

  it('the data layer (db/*, incl. mutate.ts) never imports the audit module at all', () => {
    // db/mutate.ts is included by the recursive sweep — the data layer must not even know audit.ts exists.
    const offenders = tsFilesUnder(join(SRC, 'db')).filter((f) =>
      /from '\.\.?\/audit\.js'/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
