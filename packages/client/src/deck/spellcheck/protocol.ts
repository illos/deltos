/**
 * Message protocol between the main-thread SpellEngine and the spell Web Worker. Pure types only (no DOM
 * or worker globals) so BOTH sides — the app-config engine and the webworker-config worker — can import it.
 */
import type { MisspelledRange, SpellSuggestion } from './symspell.js';

export type SpellRequest =
  | { type: 'init'; dict: string }
  | { type: 'setAllowList'; words: string[] } // user custom dictionary (fire-and-forget, no response)
  | { type: 'check'; id: number; text: string }
  | { type: 'lookup'; id: number; word: string; limit: number };

export type SpellResponse =
  | { type: 'check'; id: number; ranges: MisspelledRange[] }
  | { type: 'lookup'; id: number; suggestions: SpellSuggestion[] };
