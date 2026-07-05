/**
 * Step-2 perf gates (formula-engine.md §8; plugins-lazy-past-first-paint; performance-is-a-standing-value).
 *
 * 1. LAZY-CHUNK BOUNDARY — the same static import-graph walk as the pdf gate (pdfLazyChunk.test.ts):
 *    nothing under src/formula-engine/, and not the formulaEnvironment host module, may be STATICALLY
 *    reachable from the app entry or the editor. The only road in is the broker's dynamic `import()`,
 *    which Rollup splits into a lazy chunk (verified against the production build).
 *
 * 2. PRESENCE GATE — a formula-free note does ZERO engine work: no environment import, no graph. The gate
 *    is NodeView registration itself (construction = content-presence), proven at the broker seam and at
 *    the full ProseMirrorEditor mount (the environment module mocked so the dynamic import is observable).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFormulaBroker } from '../src/plugins/formula/formulaHost.js';
import type { FormulaHandle } from '../src/plugins/formula/formulaHost.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/main.tsx');
const EDITOR = resolve(HERE, '../src/editor/ProseMirrorEditor.tsx');
const ENVIRONMENT = resolve(HERE, '../src/plugins/formula/formulaEnvironment.ts');

function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** BFS the STATIC import graph (only `import/export ... from`) — dynamic `import()` never enters it. */
function walk(entry: string): Set<string> {
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
      if (!spec.startsWith('.')) continue;
      const next = resolveSource(file, spec);
      if (next) queue.push(next);
    }
  }
  return files;
}

const enginePath = `${sep}src${sep}formula-engine${sep}`;

describe('§8 lazy boundary — the engine + host environment are OUT of the static entry/editor graph', () => {
  it('the app entry statically reaches neither src/formula-engine/ nor formulaEnvironment', () => {
    const files = walk(ENTRY);
    expect([...files].filter((f) => f.includes(enginePath))).toEqual([]);
    expect(files.has(ENVIRONMENT)).toBe(false);
  });

  it('the editor (ProseMirrorEditor) statically reaches neither', () => {
    const files = walk(EDITOR);
    expect([...files].filter((f) => f.includes(enginePath))).toEqual([]);
    expect(files.has(ENVIRONMENT)).toBe(false);
  });

  it('sanity: formulaEnvironment IS the module that statically carries the engine (the walk is meaningful)', () => {
    const files = walk(ENVIRONMENT);
    expect([...files].some((f) => f.includes(enginePath))).toBe(true);
  });
});

describe('§8 presence gate — the broker seam', () => {
  const stubRuntime = { add: vi.fn(), update: vi.fn(), remove: vi.fn(), dispose: vi.fn() };
  const handle = (ftype: string): FormulaHandle => ({ spec: () => '1 + 1', ftype: () => ftype, render: () => {} });

  it('no registration → the environment loader is NEVER called', async () => {
    const loader = vi.fn(async () => ({ createFormulaEnvironment: () => stubRuntime }));
    createFormulaBroker(loader);
    await Promise.resolve();
    expect(loader).not.toHaveBeenCalled();
  });

  it('a NON-engine chip (hexcolor) never triggers the load either', async () => {
    const loader = vi.fn(async () => ({ createFormulaEnvironment: () => stubRuntime }));
    const broker = createFormulaBroker(loader);
    broker.register(handle('hexcolor'));
    await Promise.resolve();
    expect(loader).not.toHaveBeenCalled();
  });

  it('the FIRST engine-managed registration loads the environment exactly once and replays the handles', async () => {
    const runtime = { add: vi.fn(), update: vi.fn(), remove: vi.fn(), dispose: vi.fn() };
    const loader = vi.fn(async () => ({ createFormulaEnvironment: () => runtime }));
    const broker = createFormulaBroker(loader);
    const a = handle('math');
    const b = handle('imperial');
    broker.register(a);
    broker.register(b);
    await vi.waitFor(() => expect(runtime.add).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('dispose before the chunk lands → the environment is never built', async () => {
    let resolveLoad!: (m: { createFormulaEnvironment: () => typeof stubRuntime }) => void;
    const created = vi.fn(() => stubRuntime);
    const loader = vi.fn(() => new Promise<{ createFormulaEnvironment: () => typeof stubRuntime }>((r) => (resolveLoad = r)));
    const broker = createFormulaBroker(loader);
    broker.register(handle('math'));
    broker.dispose();
    resolveLoad({ createFormulaEnvironment: created });
    await Promise.resolve();
    expect(created).not.toHaveBeenCalled();
  });
});
