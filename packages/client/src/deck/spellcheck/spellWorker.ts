/// <reference lib="webworker" />
/**
 * Spell Web Worker — builds the SymSpell index and answers check/lookup off the main thread (#69 §5).
 * The main thread (SpellEngine) posts the dictionary text on 'init' (it owns the Vite `?raw` asset import);
 * the worker splits + builds, then serves requests. Keeping the dict transfer on the engine side means the
 * worker needs no Vite asset typing — it's pure WebWorker + the editor-agnostic SymSpell core.
 *
 * Typechecked under tsconfig.sw.json (WebWorker lib), excluded from tsconfig.app.json (DOM).
 */
import { SymSpell, checkText } from './symspell.js';
import type { SpellRequest, SpellResponse } from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

const spell = new SymSpell();
let ready = false;

self.onmessage = (e: MessageEvent<SpellRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // The dict is a frequency-ordered word list, one word per line (build assigns rank-frequency).
    spell.build(msg.dict.split('\n').filter((w) => w.length > 0));
    ready = true;
    return;
  }
  if (msg.type === 'setAllowList') {
    spell.setAllowList(msg.words); // user custom dictionary — these words are never flagged
    return;
  }
  if (!ready) return; // requests can't arrive before 'init' (messages are ordered), but guard anyway.
  if (msg.type === 'check') {
    const res: SpellResponse = { type: 'check', id: msg.id, ranges: checkText(spell, msg.text) };
    self.postMessage(res);
  } else if (msg.type === 'lookup') {
    const res: SpellResponse = { type: 'lookup', id: msg.id, suggestions: spell.lookup(msg.word).slice(0, msg.limit) };
    self.postMessage(res);
  }
};
