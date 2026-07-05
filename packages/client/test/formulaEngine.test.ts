/**
 * formula-engine tests (docs/specs/formula-engine.md) — the host-agnostic reactive core as PURE logic
 * (node environment, no editor). The load-bearing properties: order-independence (forward refs resolve),
 * incremental dirty recompute (only the changed node + transitive dependents re-evaluate — proven by
 * compute spies), early-stop on unchanged values, cycle detection → the quiet `cycle` error (never a
 * hang), unresolved references → the `unresolved` error, and the label resolver's one rule (bare label =
 * SUM of its group, locked decision #1) including live regrouping when a label gains/loses a member.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createFormulaEngine,
  createLabelResolver,
  numberValue,
  errorValue,
  valuesEqual,
  type EngineNode,
  type ReferenceResolver,
  type Value,
} from '../src/formula-engine/index.js';

/** Direct resolver: a reference token IS the target node id (the simplest possible semantics). */
const directResolver: ReferenceResolver = {
  resolve: (ref) => [ref],
  combine: (_ref, values) => values[0] ?? errorValue('unresolved'),
};

/** A constant node (no references). */
const constNode = (id: string, n: number): EngineNode => ({
  id,
  references: [],
  compute: () => numberValue(n),
});

/** A node summing its references (+ offset); the first error input propagates. */
const sumNode = (id: string, refs: readonly string[], offset = 0): EngineNode => ({
  id,
  references: refs,
  compute: (resolved) => {
    let sum = offset;
    for (const ref of refs) {
      const v = resolved.get(ref) ?? errorValue('unresolved');
      if (v.kind !== 'number') return v;
      sum += v.value;
    }
    return numberValue(sum);
  },
});

/** Wrap a node's compute in a spy so tests can prove who recomputed. */
const spied = (node: EngineNode): { node: EngineNode; compute: ReturnType<typeof vi.fn> } => {
  const compute = vi.fn(node.compute);
  return { node: { ...node, compute: compute as EngineNode['compute'] }, compute };
};

describe('formula-engine — evaluation', () => {
  it('evaluates a straight-line graph', () => {
    const engine = createFormulaEngine(directResolver);
    const values = engine.setNodes([constNode('a', 2), sumNode('b', ['a'], 1), sumNode('c', ['b'], 10)]);
    expect(values.get('a')).toEqual(numberValue(2));
    expect(values.get('b')).toEqual(numberValue(3));
    expect(values.get('c')).toEqual(numberValue(13));
  });

  it('is ORDER-INDEPENDENT: a forward reference (definition after the consumer) resolves identically', () => {
    const nodes = [sumNode('consumer', ['def'], 1), constNode('def', 41)];
    const forward = createFormulaEngine(directResolver).setNodes(nodes);
    const backward = createFormulaEngine(directResolver).setNodes([...nodes].reverse());
    expect(forward.get('consumer')).toEqual(numberValue(42));
    expect(backward.get('consumer')).toEqual(numberValue(42));
  });

  it('evaluates a DIAMOND once per node, in dependency order', () => {
    const engine = createFormulaEngine(directResolver);
    const a = spied(constNode('a', 1));
    const b = spied(sumNode('b', ['a'], 1)); // 2
    const c = spied(sumNode('c', ['a'], 2)); // 3
    const d = spied(sumNode('d', ['b', 'c'])); // 5
    const values = engine.setNodes([d.node, b.node, c.node, a.node]); // deliberately shuffled
    expect(values.get('d')).toEqual(numberValue(5));
    for (const s of [a, b, c, d]) expect(s.compute).toHaveBeenCalledTimes(1);
  });

  it('a reference that resolves to a MISSING node → the unresolved error', () => {
    const engine = createFormulaEngine(directResolver);
    const values = engine.setNodes([sumNode('a', ['nothing-here'])]);
    expect(values.get('a')).toEqual(errorValue('unresolved'));
  });

  it('a THROWING compute is caught → the eval error (engine never throws)', () => {
    const engine = createFormulaEngine(directResolver);
    const bomb: EngineNode = {
      id: 'bomb',
      references: [],
      compute: () => {
        throw new Error('boom');
      },
    };
    const values = engine.setNodes([bomb, sumNode('down', ['bomb'])]);
    expect(values.get('bomb')).toEqual(errorValue('eval'));
    expect(values.get('down')).toEqual(errorValue('eval')); // propagated by the consumer's compute
  });
});

describe('formula-engine — cycles (quiet error, never a hang)', () => {
  it('a two-node cycle poisons both with the cycle error, compute untouched', () => {
    const engine = createFormulaEngine(directResolver);
    const a = spied(sumNode('a', ['b']));
    const b = spied(sumNode('b', ['a']));
    const values = engine.setNodes([a.node, b.node]);
    expect(values.get('a')).toEqual(errorValue('cycle'));
    expect(values.get('b')).toEqual(errorValue('cycle'));
    expect(a.compute).not.toHaveBeenCalled();
    expect(b.compute).not.toHaveBeenCalled();
  });

  it('a SELF-reference is a cycle', () => {
    const engine = createFormulaEngine(directResolver);
    expect(engine.setNodes([sumNode('a', ['a'])]).get('a')).toEqual(errorValue('cycle'));
  });

  it('a node DOWNSTREAM of a cycle gets the propagated error, not a hang', () => {
    const engine = createFormulaEngine(directResolver);
    const values = engine.setNodes([sumNode('a', ['b']), sumNode('b', ['a']), sumNode('c', ['a'], 1)]);
    expect(values.get('c')).toEqual(errorValue('cycle')); // sumNode propagates the input error
  });

  it('BREAKING a cycle recovers real values', () => {
    const engine = createFormulaEngine(directResolver);
    engine.setNodes([sumNode('a', ['b']), sumNode('b', ['a']), sumNode('c', ['a'], 1)]);
    const changed = engine.upsertNode(constNode('b', 10));
    expect(changed.get('b')).toEqual(numberValue(10));
    expect(changed.get('a')).toEqual(numberValue(10));
    expect(changed.get('c')).toEqual(numberValue(11));
  });
});

describe('formula-engine — incremental dirty recompute', () => {
  it('recomputes ONLY the changed node + its transitive dependents', () => {
    const engine = createFormulaEngine(directResolver);
    const a = spied(constNode('a', 1));
    const b = spied(sumNode('b', ['a'], 1));
    const c = spied(sumNode('c', ['b'], 1));
    const x = spied(constNode('x', 100)); // unrelated island
    const y = spied(sumNode('y', ['x'], 1));
    engine.setNodes([a.node, b.node, c.node, x.node, y.node]);
    for (const s of [a, b, c, x, y]) s.compute.mockClear();

    const changed = engine.upsertNode(constNode('a', 5));
    expect(changed.get('a')).toEqual(numberValue(5));
    expect(changed.get('b')).toEqual(numberValue(6));
    expect(changed.get('c')).toEqual(numberValue(7));
    expect(changed.has('x')).toBe(false);
    expect(changed.has('y')).toBe(false);
    expect(b.compute).toHaveBeenCalledTimes(1);
    expect(c.compute).toHaveBeenCalledTimes(1);
    expect(x.compute).not.toHaveBeenCalled(); // the island never recomputes
    expect(y.compute).not.toHaveBeenCalled();
  });

  it('the ripple STOPS where a recomputed value comes out unchanged', () => {
    const engine = createFormulaEngine(directResolver);
    const b = spied(sumNode('b', ['a']));
    const c = spied(sumNode('c', ['b']));
    engine.setNodes([constNode('a', 5), b.node, c.node]);
    b.compute.mockClear();
    c.compute.mockClear();

    // Replace a's node with a DIFFERENT compute that yields the SAME value (like an edit `5` → `2+3`).
    const changed = engine.upsertNode(constNode('a', 5));
    expect(changed.size).toBe(0);
    expect(b.compute).not.toHaveBeenCalled();
    expect(c.compute).not.toHaveBeenCalled();
  });

  it('upsert returns ONLY changed values; setNodes returns EVERY value', () => {
    const engine = createFormulaEngine(directResolver);
    const all = engine.setNodes([constNode('a', 1), constNode('z', 9)]);
    expect(all.size).toBe(2);
    const changed = engine.upsertNode(constNode('a', 2));
    expect([...changed.keys()]).toEqual(['a']);
  });

  it('REMOVING a node re-evaluates its dependents (input gone → unresolved)', () => {
    const engine = createFormulaEngine(directResolver);
    engine.setNodes([constNode('a', 1), sumNode('b', ['a'])]);
    const changed = engine.removeNode('a');
    expect(changed.get('b')).toEqual(errorValue('unresolved'));
    expect(engine.getValue('a')).toBeUndefined();
  });

  it('removing an unknown id is a no-op', () => {
    const engine = createFormulaEngine(directResolver);
    engine.setNodes([constNode('a', 1)]);
    expect(engine.removeNode('ghost').size).toBe(0);
    expect(engine.getValue('a')).toEqual(numberValue(1));
  });

  it('a NEW node arriving satisfies a previously-unresolved reference', () => {
    const engine = createFormulaEngine(directResolver);
    engine.setNodes([sumNode('b', ['a'], 1)]);
    expect(engine.getValue('b')).toEqual(errorValue('unresolved'));
    const changed = engine.upsertNode(constNode('a', 4));
    expect(changed.get('b')).toEqual(numberValue(5));
  });
});

describe('formula-engine — label resolver (bare [Label] = SUM of its group, decision #1)', () => {
  /** A mutable host-side label index, as the note host will maintain it. */
  const makeIndex = () => {
    const groups = new Map<string, string[]>();
    return {
      set(label: string, ids: string[]) {
        groups.set(label, ids);
      },
      group: (label: string): readonly string[] => groups.get(label) ?? [],
    };
  };

  it('a MULTI-member label sums the group; a UNIQUE label is itself (one rule)', () => {
    const index = makeIndex();
    index.set('J', ['j1', 'j2']);
    index.set('Y', ['y1']);
    const engine = createFormulaEngine(createLabelResolver(index));
    const values = engine.setNodes([
      constNode('j1', 2),
      constNode('j2', 3),
      constNode('y1', 7),
      sumNode('totalJ', ['J']),
      sumNode('refY', ['Y'], 1),
    ]);
    expect(values.get('totalJ')).toEqual(numberValue(5));
    expect(values.get('refY')).toEqual(numberValue(8));
  });

  it('an UNKNOWN label → the unresolved error', () => {
    const engine = createFormulaEngine(createLabelResolver(makeIndex()));
    expect(engine.setNodes([sumNode('t', ['Nope'])]).get('t')).toEqual(errorValue('unresolved'));
  });

  it('a label GAINING a member re-aims existing references (structural dirt via re-resolution)', () => {
    const index = makeIndex();
    index.set('J', ['j1']);
    const engine = createFormulaEngine(createLabelResolver(index));
    engine.setNodes([constNode('j1', 2), sumNode('t', ['J'])]);
    expect(engine.getValue('t')).toEqual(numberValue(2));

    index.set('J', ['j1', 'j2']); // host updates its index FIRST (the resolver contract) …
    const changed = engine.upsertNode(constNode('j2', 3)); // … then mutates the engine
    expect(changed.get('t')).toEqual(numberValue(5));
  });

  it('a label LOSING a member re-aims too', () => {
    const index = makeIndex();
    index.set('J', ['j1', 'j2']);
    const engine = createFormulaEngine(createLabelResolver(index));
    engine.setNodes([constNode('j1', 2), constNode('j2', 3), sumNode('t', ['J'])]);
    index.set('J', ['j1']);
    const changed = engine.removeNode('j2');
    expect(changed.get('t')).toEqual(numberValue(2));
  });

  it('an ERROR member quietly poisons the aggregate (its code preserved)', () => {
    const index = makeIndex();
    index.set('J', ['j1', 'j2']);
    const engine = createFormulaEngine(createLabelResolver(index));
    const bomb: EngineNode = {
      id: 'j2',
      references: [],
      compute: () => errorValue('eval'),
    };
    const values = engine.setNodes([constNode('j1', 2), bomb, sumNode('t', ['J'])]);
    expect(values.get('t')).toEqual(errorValue('eval'));
  });

  it('label-group members on a CYCLE poison the aggregate with the cycle error', () => {
    const index = makeIndex();
    index.set('A', ['a1']);
    index.set('B', ['b1']);
    const engine = createFormulaEngine(createLabelResolver(index));
    // [A: [B]] / [B: [A]] — the locked-decision cycle case, spelled as label references.
    const values = engine.setNodes([sumNode('a1', ['B']), sumNode('b1', ['A']), sumNode('t', ['A'])]);
    expect(values.get('a1')).toEqual(errorValue('cycle'));
    expect(values.get('b1')).toEqual(errorValue('cycle'));
    expect(values.get('t')).toEqual(errorValue('cycle'));
  });
});

describe('formula-engine — guards + snapshots', () => {
  it('a THROWING resolver method is contained (resolve → no deps; combine → eval error)', () => {
    const hostile: ReferenceResolver = {
      resolve: () => {
        throw new Error('resolve boom');
      },
      combine: () => {
        throw new Error('combine boom');
      },
    };
    const engine = createFormulaEngine(hostile);
    // resolve throws → the ref resolves to nothing; combine (also throwing) → eval error input.
    const node: EngineNode = {
      id: 'n',
      references: ['r'],
      compute: (refs) => refs.get('r') ?? errorValue('unresolved'),
    };
    expect(engine.setNodes([node]).get('n')).toEqual(errorValue('eval'));
  });

  it('values() snapshots do not alias engine internals', () => {
    const engine = createFormulaEngine(directResolver);
    engine.setNodes([constNode('a', 1)]);
    const snap = engine.values();
    engine.upsertNode(constNode('a', 2));
    expect(snap.get('a')).toEqual(numberValue(1)); // the old snapshot is untouched
    expect(engine.getValue('a')).toEqual(numberValue(2));
  });

  it('duplicate reference tokens share one binding', () => {
    const engine = createFormulaEngine(directResolver);
    const node: EngineNode = {
      id: 'n',
      references: ['a', 'a'],
      compute: (refs) => {
        const v = refs.get('a')!;
        return v.kind === 'number' ? numberValue(v.value * 2) : v;
      },
    };
    expect(engine.setNodes([constNode('a', 3), node]).get('n')).toEqual(numberValue(6));
  });
});

describe('Value — equality semantics', () => {
  it('number values compare by Object.is; errors by code; cross-kind never equal', () => {
    expect(valuesEqual(numberValue(4), numberValue(4))).toBe(true);
    expect(valuesEqual(numberValue(4), numberValue(5))).toBe(false);
    expect(valuesEqual(errorValue('cycle'), errorValue('cycle'))).toBe(true);
    expect(valuesEqual(errorValue('cycle'), errorValue('eval'))).toBe(false);
    expect(valuesEqual(numberValue(0) as Value, errorValue('eval') as Value)).toBe(false);
  });
});
