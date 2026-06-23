import dictRaw from './en-words.txt?raw';
import type { MisspelledRange, SpellSuggestion } from './symspell.js';
import type { SpellRequest, SpellResponse } from './protocol.js';

/**
 * SpellEngine (#69 §5) — the main-thread handle to the spell Web Worker. Editor-AGNOSTIC (plain
 * strings/ranges; no PM types) so it lives in Deck-core. The heavy work — building the SymSpell index over
 * the ~50k-word dictionary and every lookup/check — runs in the worker, off the main thread, so typing
 * latency is never affected. Lazy: nothing here loads until the host constructs an engine (the editor
 * adapter does so only when spellcheck is ON and a note is open), and the dict rides this module's chunk.
 *
 * The dict is imported here (`?raw`, Vite-typed on the DOM side) and posted to the worker on init — so the
 * worker stays free of Vite asset imports. The one-time transfer is the only main-thread cost; the build
 * itself is in the worker.
 */
export interface SpellEngine {
  /** Misspelled ranges in `text` (char offsets). */
  check(text: string): Promise<MisspelledRange[]>;
  /** Ranked suggestions for a word (nearest + most-frequent first). */
  lookup(word: string, limit?: number): Promise<SpellSuggestion[]>;
  /** Replace the user custom-dictionary allow-list — allow-listed words are never flagged (§5.2). */
  setAllowList(words: string[]): void;
  /** Terminate the worker and free the engine ("unload" — when spellcheck is turned off). */
  dispose(): void;
}

export function createSpellEngine(): SpellEngine {
  // Defensive: no Worker (SSR / test env) → an inert engine (spellcheck simply produces nothing).
  if (typeof Worker === 'undefined') {
    return { check: async () => [], lookup: async () => [], setAllowList: () => {}, dispose: () => {} };
  }
  const worker = new Worker(new URL('./spellWorker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', dict: dictRaw } satisfies SpellRequest);

  let seq = 0;
  const pending = new Map<number, (res: SpellResponse) => void>();
  worker.onmessage = (e: MessageEvent<SpellResponse>) => {
    const resolve = pending.get(e.data.id);
    if (resolve) { pending.delete(e.data.id); resolve(e.data); }
  };

  const request = <T extends SpellResponse>(make: (id: number) => SpellRequest): Promise<T> =>
    new Promise<T>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve as (res: SpellResponse) => void);
      worker.postMessage(make(id));
    });

  return {
    check: (text) =>
      request<Extract<SpellResponse, { type: 'check' }>>((id) => ({ type: 'check', id, text })).then((r) => r.ranges),
    lookup: (word, limit = 6) =>
      request<Extract<SpellResponse, { type: 'lookup' }>>((id) => ({ type: 'lookup', id, word, limit })).then((r) => r.suggestions),
    setAllowList: (words) => worker.postMessage({ type: 'setAllowList', words } satisfies SpellRequest),
    dispose: () => { worker.terminate(); pending.clear(); },
  };
}
