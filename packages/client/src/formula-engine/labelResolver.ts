import type { ReferenceResolver } from './engine.js';
import { type Value, errorValue, numberValue } from './value.js';

/**
 * The LABEL reference resolver (docs/specs/formula-engine.md §5) — the note host's semantics, implementing
 * locked decision #1 as ONE rule: a bare `[Label]` reference means the SUM of every formula carrying that
 * label. A unique label sums a one-member group (= itself); `[Label:total]` is just an explicit synonym the
 * host normalizes to the same token before it reaches here. Still pure + host-agnostic (no DOM/PM): the
 * label → node-ids INDEX is injected, so this module never knows what a "note" or "doc walk" is — the host
 * (Step 2) maintains the index from the doc's formula nodes and must refresh it BEFORE engine mutations
 * (the resolver contract in engine.ts).
 *
 * Cross-type mixing is RAW SCALARS by design (locked decision #2): members' values are summed as plain
 * numbers in their own canonical units — no dimensional analysis. The CONSUMING formula's type formats the
 * result (a math formula shows an imperial reference as inches-the-number).
 */

/** The host-maintained label index: label → the node ids currently carrying it (unknown label → []). */
export interface LabelIndex {
  group(label: string): readonly string[];
}

export function createLabelResolver(index: LabelIndex): ReferenceResolver {
  return {
    resolve: (ref) => index.group(ref),

    combine: (_ref, values): Value => {
      if (values.length === 0) return errorValue('unresolved'); // the label names nothing
      let sum = 0;
      for (const v of values) {
        if (v.kind === 'error') return v; // a broken member quietly poisons the aggregate (keeps its code)
        if (v.kind !== 'number') return errorValue('eval'); // future non-numeric arms don't sum
        sum += v.value;
      }
      return numberValue(sum);
    },
  };
}
