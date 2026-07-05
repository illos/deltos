import { type Value, errorValue, valuesEqual } from './value.js';

/**
 * The reactive computation ENGINE (docs/specs/formula-engine.md §4) — a dependency graph + incremental
 * evaluator over abstract nodes. This is the compute core the inline-formula reference/totalizer features
 * AND a future spreadsheet/database plugin share, so it is strictly HOST-AGNOSTIC:
 *
 *   - It deals in opaque node IDs and opaque reference TOKENS. What a reference MEANS (a label naming a
 *     group of formulas, a grid coordinate, a range) is the injected {@link ReferenceResolver}'s business —
 *     label semantics (bare `[Label]` = SUM of the label's group, locked decision #1) live in the note
 *     host's resolver (see labelResolver.ts), never here.
 *   - It never parses specs. A node's `compute` closure (built by the host from the type's
 *     NumericFormula.toNumber) turns resolved reference values into the node's own Value.
 *   - No ProseMirror / DOM / editor imports. Fully synchronous + deterministic — scheduling (microtask
 *     coalescing per editor transaction) is the host wiring's job, one layer up.
 *
 * Evaluation is ORDER-INDEPENDENT (locked decision #3): values fall out of a topological pass over the
 * whole graph (Tarjan SCC), so a reference resolves whether its definition sits above or below it in the
 * document. CYCLES (locked decision #4) are detected as SCCs and quietly poisoned with the `cycle` error
 * Value — compute is never invoked for a cycle member, nothing hangs or recurses.
 *
 * INCREMENTAL: a mutation recomputes only the mutated/structurally-dirty nodes plus their TRANSITIVE
 * DEPENDENTS — and the ripple stops early where a recomputed value comes out unchanged. Reference EDGES are
 * re-resolved on every mutation (pure id lookups, O(total refs) — cheap next to parsing), because a
 * mutation elsewhere can silently re-aim a reference (e.g. a second node adopting a label changes what that
 * label's reference includes). Nothing is ever persisted from here (locked decision #6).
 */

/** One computation unit — for the note host, one formula node in the doc. */
export interface EngineNode {
  /** Stable opaque id (the host's formula-node identity). */
  readonly id: string;
  /** The reference TOKENS this node's spec consumes (e.g. the `Y` of `[Y]`) — opaque to the engine;
   *  the resolver interprets them. Duplicates are fine (they share one binding). */
  readonly references: readonly string[];
  /**
   * Compute this node's value given its resolved references (one combined Value per reference token).
   * MUST be pure and non-throwing (a throw is caught → the `eval` error Value). A reference that named
   * nothing arrives as an error Value — the compute decides whether to propagate it (numeric ones do).
   */
  compute(refs: ReadonlyMap<string, Value>): Value;
}

/**
 * The pluggable REFERENCE semantics — the seam that keeps the engine host-agnostic. The note host supplies
 * a label resolver (label → the ids of every formula carrying it, combined by SUM); a future grid supplies
 * a coordinate/range resolver. CONTRACT: both methods are pure, non-throwing (throws are caught → error
 * Values), and reflect the CURRENT node population at call time — the host must update its index (label
 * map, grid) BEFORE calling the engine mutation that depends on it.
 */
export interface ReferenceResolver {
  /** Resolve a reference token (as seen from `fromId`) to the node ids it depends on. Unknown → []. */
  resolve(ref: string, fromId: string): readonly string[];
  /** Fold the resolved nodes' values into the ONE Value the reference yields (label = sum; range = array). */
  combine(ref: string, values: readonly Value[]): Value;
}

export interface FormulaEngine {
  /** Replace the whole node population (note open / full rescan). Returns EVERY node's value. */
  setNodes(nodes: readonly EngineNode[]): ReadonlyMap<string, Value>;
  /** Add or replace one node (a spec edit / a new formula). Returns only the values that CHANGED. */
  upsertNode(node: EngineNode): ReadonlyMap<string, Value>;
  /** Remove one node (formula deleted). Returns only the values that CHANGED. */
  removeNode(id: string): ReadonlyMap<string, Value>;
  /** The current value of one node (undefined = unknown id). */
  getValue(id: string): Value | undefined;
  /** A snapshot of every node's current value. */
  values(): ReadonlyMap<string, Value>;
}

interface Entry {
  node: EngineNode;
  /** This node's edges as of the last resolution: ref token → resolved target ids. */
  deps: Map<string, readonly string[]>;
  value: Value;
  /** True until the first evaluation — a fresh node always reports its value as "changed". */
  fresh: boolean;
}

export function createFormulaEngine(resolver: ReferenceResolver): FormulaEngine {
  const entries = new Map<string, Entry>();

  /** Resolve one node's reference tokens to edges. Guarded: a throwing resolve resolves to nothing. */
  function resolveDeps(node: EngineNode): Map<string, readonly string[]> {
    const deps = new Map<string, readonly string[]>();
    for (const ref of node.references) {
      if (deps.has(ref)) continue; // duplicate tokens share one binding
      let ids: readonly string[];
      try {
        ids = resolver.resolve(ref, node.id);
      } catch {
        ids = [];
      }
      deps.set(ref, ids);
    }
    return deps;
  }

  function sameIds(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /**
   * Re-resolve EVERY entry's edges against the resolver's current view; returns the ids whose edge set
   * changed (they must recompute — a reference now points at different nodes). Cheap by design: pure
   * lookups, no spec parsing, no evaluation.
   */
  function reresolveAll(): Set<string> {
    const structurallyDirty = new Set<string>();
    for (const [id, entry] of entries) {
      const next = resolveDeps(entry.node);
      let changed = next.size !== entry.deps.size;
      if (!changed) {
        for (const [ref, ids] of next) {
          const prev = entry.deps.get(ref);
          if (!prev || !sameIds(prev, ids)) {
            changed = true;
            break;
          }
        }
      }
      entry.deps = next;
      if (changed) structurallyDirty.add(id);
    }
    return structurallyDirty;
  }

  /** Reverse-edge map: target id → the ids referencing it. Keyed even for targets with no entry yet. */
  function buildDependents(): Map<string, Set<string>> {
    const dependents = new Map<string, Set<string>>();
    for (const [id, entry] of entries) {
      for (const ids of entry.deps.values()) {
        for (const target of ids) {
          let set = dependents.get(target);
          if (!set) dependents.set(target, (set = new Set()));
          set.add(id);
        }
      }
    }
    return dependents;
  }

  /** The dirty CLOSURE: the seeds plus every transitive dependent (only these may need recomputing). */
  function affectedFrom(seeds: ReadonlySet<string>): Set<string> {
    const dependents = buildDependents();
    const affected = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (affected.has(id) || !entries.has(id)) continue;
      affected.add(id);
      for (const dep of dependents.get(id) ?? []) stack.push(dep);
    }
    return affected;
  }

  /** A node's dependency edges RESTRICTED to the affected set (edges out of it are settled inputs). */
  function affectedEdges(id: string, affected: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const ids of entries.get(id)!.deps.values()) {
      for (const target of ids) if (affected.has(target)) out.push(target);
    }
    return out;
  }

  /**
   * Evaluate the affected subgraph: Tarjan SCC (iterative — no recursion to blow) emits components in
   * dependency-first order; a component of size >1 (or a self-loop) is a CYCLE → members are poisoned with
   * the `cycle` error, compute untouched. Singles evaluate in order, SKIPPING nodes none of whose inputs
   * changed (the early-stop that keeps a keystroke's ripple minimal). Returns the changed values.
   */
  function evaluate(affected: ReadonlySet<string>, seeds: ReadonlySet<string>): Map<string, Value> {
    const changed = new Map<string, Value>();

    // — Tarjan over the affected subgraph —
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;

    for (const root of affected) {
      if (index.has(root)) continue;
      const frames: { id: string; edges: string[]; i: number }[] = [];
      const open = (id: string): void => {
        index.set(id, counter);
        low.set(id, counter);
        counter++;
        stack.push(id);
        onStack.add(id);
        frames.push({ id, edges: affectedEdges(id, affected), i: 0 });
      };
      open(root);
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.i < frame.edges.length) {
          const target = frame.edges[frame.i++]!;
          if (!index.has(target)) open(target);
          else if (onStack.has(target)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(target)!));
        } else {
          frames.pop();
          const parent = frames[frames.length - 1];
          if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
          if (low.get(frame.id) === index.get(frame.id)) {
            const scc: string[] = [];
            for (;;) {
              const member = stack.pop()!;
              onStack.delete(member);
              scc.push(member);
              if (member === frame.id) break;
            }
            sccs.push(scc);
          }
        }
      }
    }

    // — evaluate components dependency-first —
    const record = (entry: Entry, id: string, next: Value): void => {
      if (entry.fresh || !valuesEqual(entry.value, next)) changed.set(id, next);
      entry.value = next;
      entry.fresh = false;
    };

    for (const scc of sccs) {
      const isCycle = scc.length > 1 || affectedEdges(scc[0]!, affected).includes(scc[0]!);
      if (isCycle) {
        for (const id of scc) record(entries.get(id)!, id, errorValue('cycle'));
        continue;
      }
      const id = scc[0]!;
      const entry = entries.get(id)!;

      // Early stop: a non-seed whose inputs all held their values cannot change — skip its compute.
      const mustCompute =
        seeds.has(id) ||
        [...entry.deps.values()].some((ids) => ids.some((target) => changed.has(target)));
      if (!mustCompute) continue;

      const refs = new Map<string, Value>();
      for (const [ref, ids] of entry.deps) {
        const inputs = ids.map((target) => entries.get(target)?.value ?? errorValue('unresolved'));
        let combined: Value;
        try {
          combined = resolver.combine(ref, inputs);
        } catch {
          combined = errorValue('eval');
        }
        refs.set(ref, combined);
      }
      let next: Value;
      try {
        next = entry.node.compute(refs);
      } catch {
        next = errorValue('eval');
      }
      record(entry, id, next);
    }
    return changed;
  }

  /** The shared mutation tail: re-aim edges, close over dependents, evaluate. */
  function mutate(seedIds: Iterable<string>): Map<string, Value> {
    const seeds = new Set<string>();
    for (const id of seedIds) if (entries.has(id)) seeds.add(id);
    for (const id of reresolveAll()) seeds.add(id);
    return evaluate(affectedFrom(seeds), seeds);
  }

  return {
    setNodes(nodes) {
      entries.clear();
      for (const node of nodes) {
        entries.set(node.id, { node, deps: new Map(), value: errorValue('unresolved'), fresh: true });
      }
      mutate(entries.keys());
      return this.values();
    },

    upsertNode(node) {
      const prev = entries.get(node.id);
      entries.set(node.id, {
        node,
        deps: prev?.deps ?? new Map(),
        value: prev?.value ?? errorValue('unresolved'),
        fresh: !prev,
      });
      return mutate([node.id]);
    },

    removeNode(id) {
      const entry = entries.get(id);
      if (!entry) return new Map();
      // Its dependents must recompute even if the resolver's mapping is momentarily stale (contract says
      // the host updates its index first, but don't bet correctness on it — the input is gone regardless).
      const seeds: string[] = [];
      for (const [otherId, other] of entries) {
        if (otherId === id) continue;
        for (const ids of other.deps.values()) {
          if (ids.includes(id)) {
            seeds.push(otherId);
            break;
          }
        }
      }
      entries.delete(id);
      return mutate(seeds);
    },

    getValue(id) {
      return entries.get(id)?.value;
    },

    values() {
      const snapshot = new Map<string, Value>();
      for (const [id, entry] of entries) snapshot.set(id, entry.value);
      return snapshot;
    },
  };
}
