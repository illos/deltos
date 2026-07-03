import { chainCommands } from 'prosemirror-commands';
import type { Command } from 'prosemirror-state';
import type { EditTransform } from './registry.js';

/**
 * The edit-transform surface compiler (design §3.4). Backspace/forward-delete/Enter-boundary transforms
 * (formula unwrap, link unwrap, atom single-press delete, boundary wraps) can't be post-hoc — they're
 * compiled into ONE chained command per surface, consumed by BOTH the native keymap and the deckAdapter.
 * Registration order IS the chain order (load-bearing — see registry.ts).
 */
export function compileEditChain(transforms: readonly EditTransform[]): Command {
  if (transforms.length === 0) return () => false;
  return chainCommands(...transforms.map((t) => t.cmd));
}
