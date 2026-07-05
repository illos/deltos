import type { FormulaOutput } from './formulaTypes.js';
import { REFERENCE_FTYPE } from './referenceType.js';

/**
 * The formula HOST BROKER (formula-engine.md §6/§8, Step 2) — the tiny EAGER seam between the formula
 * NodeViews and the LAZY reactive environment. This file must stay engine-free: everything engine-shaped
 * (the graph, the label resolver, the display-type rule) lives in formulaEnvironment.ts, reached ONLY via
 * the dynamic `import()` below (plugins-lazy-past-first-paint).
 *
 * PRESENCE GATE (§8): the broker loads the environment chunk the FIRST time an engine-managed formula
 * NodeView registers — NodeView construction IS content-presence (ProseMirror builds every node's view at
 * editor creation, and a newly typed formula constructs one too). A note with no formulas — or with only
 * non-numeric chips (hexcolor) — never triggers the import: zero bytes, zero graph, zero work.
 *
 * IDENTITY (Step-2 locked decision #2): node ids are EPHEMERAL per-open handles — the registered sink
 * objects themselves key the environment's maps. Nothing is persisted; the whole environment is rebuilt
 * when a note (re)opens because its NodeViews re-register into a fresh broker.
 */

/** The formula ftypes the reactive environment manages (participate in the reference graph). */
export const ENGINE_FTYPES: ReadonlySet<string> = new Set(['math', 'imperial', REFERENCE_FTYPE]);

/** The ftypes whose spec may carry a PUBLISHING `Label:` tag (reference chips never publish — their spec
 *  text `Y:total` merely NAMES a reference and must not be read as a label). */
export const LABELED_FTYPES: ReadonlySet<string> = new Set(['math', 'imperial']);

/**
 * What a formula NodeView exposes to the environment: live spec/ftype reads (always current — the
 * environment re-reads on every dirty mark) and the render sink the engine pushes computed output into.
 */
export interface FormulaHandle {
  /** The node's current spec text (the editable content). */
  spec(): string;
  /** The node's formula type id. */
  ftype(): string;
  /** Render a host-computed output ( = value / the quiet = ?). Called ONLY when the output changed. */
  render(output: FormulaOutput): void;
}

/** The lazy environment's surface (implemented by formulaEnvironment.createFormulaEnvironment). All three
 *  mutations coalesce into ONE microtask flush per editor-transaction burst (§8). */
export interface FormulaEnvironmentRuntime {
  add(handle: FormulaHandle): void;
  update(handle: FormulaHandle): void;
  remove(handle: FormulaHandle): void;
  dispose(): void;
}

interface EnvironmentModule {
  createFormulaEnvironment(): FormulaEnvironmentRuntime;
}

/** The per-editor broker the NodeViews talk to (one per EditorView; dispose on editor teardown). */
export interface FormulaBroker {
  register(handle: FormulaHandle): void;
  update(handle: FormulaHandle): void;
  remove(handle: FormulaHandle): void;
  dispose(): void;
}

const defaultLoader = (): Promise<EnvironmentModule> => import('./formulaEnvironment.js');

/**
 * Build a broker. `loader` is a test seam; production uses the dynamic import above (the module boundary
 * Rollup splits into the lazy engine chunk).
 */
export function createFormulaBroker(loader: () => Promise<EnvironmentModule> = defaultLoader): FormulaBroker {
  let runtime: FormulaEnvironmentRuntime | null = null;
  let loading = false;
  let disposed = false;
  /** Handles that registered before the environment chunk arrived — replayed into it on attach. */
  const buffered = new Set<FormulaHandle>();

  const managed = (handle: FormulaHandle): boolean => ENGINE_FTYPES.has(handle.ftype());

  function ensureLoaded(): void {
    if (runtime || loading || disposed) return;
    loading = true;
    void loader()
      .then((mod) => {
        if (disposed) return;
        runtime = mod.createFormulaEnvironment();
        for (const handle of buffered) runtime.add(handle);
        buffered.clear();
      })
      .catch(() => {
        // Chunk unavailable (offline first-load edge) → formulas stay on their local, env-free render
        // (' = ?' for references). Nothing throws into the editor.
      })
      .finally(() => {
        loading = false;
      });
  }

  return {
    register(handle) {
      if (disposed || !managed(handle)) return;
      if (runtime) runtime.add(handle);
      else {
        buffered.add(handle);
        ensureLoaded(); // the presence gate: first managed formula → load the environment chunk
      }
    },
    update(handle) {
      if (disposed || !managed(handle)) return;
      // Pre-attach updates need no bookkeeping: the attach replay reads spec() live.
      if (runtime) runtime.update(handle);
    },
    remove(handle) {
      if (runtime) runtime.remove(handle);
      else buffered.delete(handle);
    },
    dispose() {
      disposed = true;
      buffered.clear();
      runtime?.dispose();
      runtime = null;
    },
  };
}
