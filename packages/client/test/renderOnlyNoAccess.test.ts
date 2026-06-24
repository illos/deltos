/**
 * #125 A3 secSys watch (#679): capabilities drive RENDER DEGRADATION ONLY, never access. The render-only
 * path must not make a network request — 'online-only → degraded render', NOT 'online-only → client
 * allow/deny fetch'. This statically walks the import graph from renderOnly.tsx and asserts no file in it
 * makes a fetch() call or imports the unfurl client. (Access enforcement stays server-side.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/plugins/runtime/renderOnly.tsx');

function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** All source files reachable from the entry via relative imports (the render-only module graph). */
function graphFiles(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const importRe = /from\s+['"]([^'"]+)['"]/g;
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) {
        const next = resolveSource(file, spec);
        if (next) queue.push(next);
      }
    }
  }
  return [...seen];
}

describe('#125 render-only path makes NO network access', () => {
  const files = graphFiles(ENTRY);

  it('no file in the render-only graph calls fetch()', () => {
    const offenders = files.filter((f) => /\bfetch\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no file in the render-only graph imports the unfurl client', () => {
    // Match an import SPECIFIER referencing unfurl (static `from '…unfurl…'` or dynamic `import('…unfurl…')`),
    // not the word in prose — the comments here legitimately explain why no fetch happens.
    const importsUnfurl = (src: string) =>
      /\bfrom\s+['"][^'"]*unfurl[^'"]*['"]/.test(src) || /\bimport\(\s*['"][^'"]*unfurl/.test(src);
    const offenders = files.filter((f) => importsUnfurl(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
