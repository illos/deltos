import {
  createFormulaEngine,
  createLabelResolver,
  numberValue,
  errorValue,
  type EngineNode,
  type Value,
} from '../../formula-engine/index.js';
import { bindRefs, extractLabel, refTokenName } from './refBinding.js';
import { REFERENCE_FTYPE } from './referenceType.js';
import { LABELED_FTYPES, type FormulaEnvironmentRuntime, type FormulaHandle } from './formulaHost.js';
import type { FormulaOutput } from './formulaTypes.js';
import type { NumericFormula } from './numericFormula.js';
import { mathNumeric } from '../math/mathType.js';
import { imperialNumeric } from '../imperial/imperialType.js';

/**
 * The note-host FORMULA ENVIRONMENT (formula-engine.md §6, Step 2) — the LAZY module that adapts the
 * host-agnostic engine (src/formula-engine/) to the editor's formula NodeViews. This file is the only
 * static importer of the engine, so Rollup splits engine + environment into one lazy chunk the broker
 * (formulaHost.ts) dynamic-imports on formula presence (§8). Never static-import this from anything eager.
 *
 * What it owns:
 *  - the HANDLE population: one EngineNode per registered NodeView handle (ephemeral per-open ids,
 *    decision #2 — nothing persisted, decision #6);
 *  - the LABEL INDEX (label → node ids), refreshed BEFORE every engine mutation (the resolver contract);
 *  - COALESCED incremental recompute (§8): add/update/remove marks coalesce into ONE microtask flush per
 *    editor-transaction burst; the engine's changed-only returns re-render exactly the changed NodeViews;
 *  - the DISPLAY-TYPE rule for bare references (Step-2 locked decision #5): a consuming expression formats
 *    per its OWN type; a bare `[Y]` / `[J:total]` chip formats with the referenced group's type when the
 *    group is type-HOMOGENEOUS, and renders the quiet ' = ?' when the group is MIXED-type. The engine
 *    stays unit-blind — this rule lives entirely here, host-side.
 */

/** The numeric formatter per engine-managed value-producing ftype (the display seam of decision #5). */
const NUMERIC_BY_FTYPE: Readonly<Record<string, NumericFormula>> = {
  math: mathNumeric,
  imperial: imperialNumeric,
};

interface Entry {
  readonly id: string;
  readonly handle: FormulaHandle;
  readonly ftype: string;
  /** The published label (LABELED_FTYPES only), as of the last flush. */
  label: string | null;
  /** The spec's reference names, as of the last flush (a bare-ref chip has exactly one — its own token). */
  refs: readonly string[];
  /** Last output pushed to the NodeView — the changed-only re-render gate. */
  lastOutput: FormulaOutput | null;
}

const sameOutput = (a: FormulaOutput | null, b: FormulaOutput): boolean =>
  a !== null && a.ok === b.ok && a.display === b.display;

export function createFormulaEnvironment(): FormulaEnvironmentRuntime {
  const byHandle = new Map<FormulaHandle, Entry>();
  const byId = new Map<string, Entry>();
  /** label → ids of the formulas publishing it (the LabelIndex the resolver reads). */
  const labelIndex = new Map<string, Set<string>>();
  let nextId = 1;
  let disposed = false;

  const engine = createFormulaEngine(
    createLabelResolver({ group: (label) => [...(labelIndex.get(label) ?? [])] }),
  );

  // ── coalescing (§8): one microtask flush per transaction burst ─────────────────────────────
  const pendingUpsert = new Set<FormulaHandle>();
  const pendingRemove = new Set<Entry>();
  let flushScheduled = false;

  function schedule(): void {
    if (flushScheduled || disposed) return;
    flushScheduled = true;
    queueMicrotask(flush);
  }

  function indexLabel(label: string, id: string): void {
    let set = labelIndex.get(label);
    if (!set) labelIndex.set(label, (set = new Set()));
    set.add(id);
  }

  function unindexLabel(label: string, id: string): void {
    const set = labelIndex.get(label);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) labelIndex.delete(label);
  }

  /** Derive an entry's published label + reference names from its CURRENT spec. */
  function deriveMeta(entry: Entry): { label: string | null; refs: readonly string[] } {
    const spec = entry.handle.spec();
    if (entry.ftype === REFERENCE_FTYPE) {
      // The chip's whole spec IS the reference token ('Y' / 'J:total' → the normalized name).
      const name = refTokenName(spec);
      return { label: null, refs: name === null ? [] : [name] };
    }
    const { label, body } = extractLabel(spec);
    return {
      label: LABELED_FTYPES.has(entry.ftype) ? label : null,
      refs: bindRefs(body).refs,
    };
  }

  /** Build the EngineNode for an entry: references from the binder; compute through the type's grammar. */
  function buildEngineNode(entry: Entry): EngineNode {
    const spec = entry.handle.spec();
    if (entry.ftype === REFERENCE_FTYPE) {
      const name = entry.refs[0];
      return {
        id: entry.id,
        references: entry.refs,
        compute: (resolved) => (name === undefined ? errorValue('unresolved') : resolved.get(name) ?? errorValue('unresolved')),
      };
    }
    const nf = NUMERIC_BY_FTYPE[entry.ftype];
    return {
      id: entry.id,
      references: entry.refs,
      compute: (resolved) => {
        if (!nf) return errorValue('eval');
        const env = {
          resolveRef: (name: string): number | null => {
            const v = resolved.get(name);
            return v !== undefined && v.kind === 'number' ? v.value : null;
          },
        };
        const n = nf.toNumber(spec, env);
        if (n !== null) return numberValue(n);
        // A failed parse caused by a broken reference keeps the reference's error code (a cycle reads
        // as a cycle downstream); a plain malformed spec is an eval error.
        for (const v of resolved.values()) if (v.kind === 'error') return v;
        return errorValue('eval');
      },
    };
  }

  /** The display rule (decision #5). `value` is the engine's computed Value for the entry. */
  function outputFor(entry: Entry): FormulaOutput {
    const value = engine.getValue(entry.id);
    if (!value || value.kind !== 'number') return { ok: false }; // quiet ' = ?' (unresolved/cycle/eval)
    if (entry.ftype === REFERENCE_FTYPE) {
      // Bare reference/totalizer: format with the referenced GROUP's type — homogeneous → that type;
      // mixed-type (or an unformattable member type) → the quiet ' = ?'.
      const name = entry.refs[0];
      const ids = name === undefined ? [] : [...(labelIndex.get(name) ?? [])];
      if (ids.length === 0) return { ok: false };
      let groupFtype: string | null = null;
      for (const id of ids) {
        const member = byId.get(id);
        if (!member) return { ok: false };
        if (groupFtype === null) groupFtype = member.ftype;
        else if (groupFtype !== member.ftype) return { ok: false }; // MIXED → ' = ?'
      }
      const nf = groupFtype === null ? undefined : NUMERIC_BY_FTYPE[groupFtype];
      return nf ? { ok: true, display: nf.format(value.value) } : { ok: false };
    }
    const nf = NUMERIC_BY_FTYPE[entry.ftype];
    return nf ? { ok: true, display: nf.format(value.value) } : { ok: false };
  }

  function flush(): void {
    flushScheduled = false;
    if (disposed) return;

    const changed = new Map<string, Value>();
    /** Labels whose group MEMBERSHIP changed this flush — their bare-ref chips may change display TYPE
     *  even when the summed value held (e.g. a 0-valued member of another type joining the group). */
    const touchedLabels = new Set<string>();

    // Removals first (their dependents recompute against the shrunken index).
    for (const entry of pendingRemove) {
      if (entry.label !== null) {
        unindexLabel(entry.label, entry.id);
        touchedLabels.add(entry.label);
      }
      byHandle.delete(entry.handle);
      byId.delete(entry.id);
      for (const [id, v] of engine.removeNode(entry.id)) changed.set(id, v);
    }
    pendingRemove.clear();

    // Adds + dirty updates: refresh the index BEFORE each engine mutation (the resolver contract).
    const upserts = [...pendingUpsert];
    pendingUpsert.clear();
    for (const handle of upserts) {
      let entry = byHandle.get(handle);
      if (!entry) {
        entry = { id: `f${nextId++}`, handle, ftype: handle.ftype(), label: null, refs: [], lastOutput: null };
        byHandle.set(handle, entry);
        byId.set(entry.id, entry);
      }
      const meta = deriveMeta(entry);
      if (entry.label !== meta.label) {
        if (entry.label !== null) {
          unindexLabel(entry.label, entry.id);
          touchedLabels.add(entry.label);
        }
        if (meta.label !== null) {
          indexLabel(meta.label, entry.id);
          touchedLabels.add(meta.label);
        }
        entry.label = meta.label;
      }
      entry.refs = meta.refs;
      for (const [id, v] of engine.upsertNode(buildEngineNode(entry))) changed.set(id, v);
    }

    // Changed-only re-render (§8): the engine's changed values, plus bare-ref chips whose referenced
    // group's membership changed (display-type may flip without a value change). The per-entry lastOutput
    // comparison makes the push idempotent — a formula whose output didn't change re-renders nothing.
    const renderIds = new Set(changed.keys());
    if (touchedLabels.size > 0) {
      for (const entry of byId.values()) {
        if (entry.ftype === REFERENCE_FTYPE && entry.refs[0] !== undefined && touchedLabels.has(entry.refs[0])) {
          renderIds.add(entry.id);
        }
      }
    }
    for (const id of renderIds) {
      const entry = byId.get(id);
      if (!entry) continue; // removed this flush
      const output = outputFor(entry);
      if (sameOutput(entry.lastOutput, output)) continue;
      entry.lastOutput = output;
      entry.handle.render(output);
    }
  }

  return {
    add(handle) {
      pendingUpsert.add(handle);
      schedule();
    },
    update(handle) {
      pendingUpsert.add(handle);
      schedule();
    },
    remove(handle) {
      pendingUpsert.delete(handle);
      const entry = byHandle.get(handle);
      if (entry) {
        pendingRemove.add(entry);
        schedule();
      }
    },
    dispose() {
      disposed = true;
      pendingUpsert.clear();
      pendingRemove.clear();
      byHandle.clear();
      byId.clear();
      labelIndex.clear();
    },
  };
}
