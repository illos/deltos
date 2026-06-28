/**
 * PDF reader Slice 1 — perf north-star gate (pdf-reader.md gate PDF-P; performance-is-a-standing-value,
 * plugins-lazy-past-first-paint). The same static import-graph walk used for the render-only PM-free gate
 * (renderOnlyPmFree.test.ts): pdf.js must be reachable ONLY through a dynamic `import()`, never a static one.
 *
 * Asserts:
 *   1. `pdfjs-dist` is NOT a static value import anywhere in FileNoteView's import graph — proving the reader
 *      (and through it pdf.js) is a second-level `import()` off the pdf branch, not a static dependency. So
 *      opening an image/normal note, or just loading FileNoteView, pulls ZERO pdf.js bytes.
 *   2. `PdfReader`/`pdfEngine` are likewise not statically reachable from FileNoteView.
 *   3. (sanity) `pdfjs-dist` IS statically reachable from pdfEngine — i.e. the engine module is genuinely the
 *      thing that carries pdf.js, so #1 is meaningful (not a false pass from a renamed dep).
 *
 * The production build corroborates this: pdf.js lands in its own `assets/pdfjs-*.js` chunk (~476 KB) +
 * `assets/pdf.worker-*.js`, separate from FileNoteView's ~4 KB chunk and absent from the entry/index chunk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE_NOTE_VIEW = resolve(HERE, '../src/views/FileNoteView.tsx');
const PDF_ENGINE = resolve(HERE, '../src/views/pdf/pdfEngine.ts');

function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** BFS the STATIC import graph (only `import/export ... from`), following relative specifiers, collecting both
 *  the bare specifiers reached and the set of relative source files visited. Dynamic `import()` is NOT matched
 *  by the `from` regex, so a lazily-imported module never enters this graph — exactly the boundary we assert. */
function walk(entry: string): { bare: Set<string>; files: Set<string> } {
  const bare = new Set<string>();
  const files = new Set<string>();
  const queue = [entry];
  const importRe = /^\s*(import|export)\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm;
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      if (m[2]) continue; // `import type` — erased at build
      const spec = m[3]!;
      if (spec.startsWith('.')) {
        const next = resolveSource(file, spec);
        if (next) queue.push(next);
      } else {
        bare.add(spec);
      }
    }
  }
  return { bare, files };
}

describe('PDF-P — pdf.js is lazy, out of FileNoteView’s static graph', () => {
  it('FileNoteView’s static import graph pulls no pdfjs-dist (the reader is a second-level import())', () => {
    const { bare, files } = walk(FILE_NOTE_VIEW);
    expect([...bare].filter((s) => s.startsWith('pdfjs-dist'))).toEqual([]);
    // The reader + engine modules are not statically reachable either.
    expect([...files].some((f) => /views\/pdf\/(PdfReader|pdfEngine)\./.test(f))).toBe(false);
  });

  it('sanity: pdfjs-dist IS statically reachable from pdfEngine (it is the module that carries pdf.js)', () => {
    const { bare } = walk(PDF_ENGINE);
    expect([...bare].some((s) => s.startsWith('pdfjs-dist'))).toBe(true);
  });
});
