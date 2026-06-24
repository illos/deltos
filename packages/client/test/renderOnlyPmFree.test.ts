/**
 * #124 A2 accept (load-bearing): the render-only path is PM-FREE. A read-only surface (search peek, list
 * preview, share) must NOT pull prosemirror-* — that's the whole point of fork b (§5,
 * [[performance-is-a-standing-value]]). This statically walks the import graph from renderOnly.tsx and
 * asserts no VALUE import of any prosemirror-* module (type-only imports are erased, so they're ignored).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/plugins/runtime/renderOnly.tsx');

/** Resolve a relative import specifier ('../x/y.js') to its on-disk source file. */
function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** BFS the import graph; collect every bare (non-relative) VALUE import specifier. */
function collectBareValueImports(entry: string): Set<string> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  // import/export ... from '...'  — skip lines that are `import type` / `export type` (erased).
  const importRe = /^\s*(import|export)\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm;

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const isType = !!m[2];
      const spec = m[3]!;
      if (isType) continue; // erased at build — never reaches the bundle
      if (spec.startsWith('.')) {
        const next = resolveSource(file, spec);
        if (next) queue.push(next);
      } else {
        bare.add(spec);
      }
    }
  }
  return bare;
}

describe('#124 render-only path is PM-free', () => {
  it('renderOnly.tsx pulls no prosemirror-* value import (search/preview stay light)', () => {
    const bare = collectBareValueImports(ENTRY);
    const pm = [...bare].filter((s) => s.startsWith('prosemirror-'));
    expect(pm).toEqual([]);
  });
});
