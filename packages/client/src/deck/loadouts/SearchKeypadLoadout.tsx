import type { KeyActions } from '../types.js';
import { Keypad } from './Keypad.js';

/**
 * SearchKeypadLoadout — the KEYS-ONLY Deck loadout for in-place search (mobile). A thin sibling of
 * {@link KeypadLoadout} that reuses the SAME markup skeleton (.keypad-loadout + .keypad-loadout__base)
 * and the SAME {@link Keypad} key rows, so the key geometry is pixel-identical to the editor keypad —
 * Jim's muscle-memory hard requirement — WITHOUT touching KeypadLoadout's editor path.
 *
 * Differences from the editor keypad, by design:
 *   - NO top slot (no formatting submenu / spell bar / link entry / voice waveform),
 *   - the persistent base region is KEPT but EMPTY — no group selector, no mic, no undo/redo, no
 *     show/hide toggle. Its constant 47px height is what puts the keys at the exact native vertical
 *     position (the band native reserves), and the empty container reserves the spot where filter tools
 *     will live later. The Deck's own safe-area bottom padding rides underneath (deck.css .deck).
 */
export function SearchKeypadLoadout({ actions }: { actions: KeyActions }) {
  return (
    <div className="keypad-loadout">
      <Keypad actions={actions} />
      {/* Empty base region — reserved for future filter tools; its fixed height locks the key geometry. */}
      <div className="keypad-loadout__base" />
    </div>
  );
}
