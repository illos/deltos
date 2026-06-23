import { DesktopLinkForm } from './DesktopLinkForm.js';
import { SpellSuggestionBar } from './SpellSuggestionBar.js';

/**
 * DesktopContextSlot (#69 desktop Deck) — the desktop Deck's OPTIONAL BOTTOM-MOUNTED context slot. The
 * desktop Deck is a sticky TOP control strip (EditorControlStrip) plus THIS bottom slot for context-
 * dependent tooling. It is position:fixed (out of flow) and renders ONLY when an occupant is active — so it
 * reserves NO space and can never reflow/jump the page when it appears or clears (the no-jump goal, solved
 * by being out of flow rather than by reserving height).
 *
 * One slot, many occupants by precedence: the link form (when adding a link) > the spell suggestion bar
 * (when the caret is on a misspelling) > nothing (slot not rendered). Any future contextual tool populates
 * the same slot. Desktop only — mobile keeps the Deck top-slot bar.
 */
export interface ContextSlotLink {
  open: boolean;
  title: string;
  url: string;
  onChangeTitle: (v: string) => void;
  onChangeUrl: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export interface ContextSlotSpell {
  word: string;
  suggestions: string[];
  onPick: (word: string) => void;
  onAddToDictionary: () => void;
}

interface DesktopContextSlotProps {
  /** The link form, IF it's mounted in the bottom slot (the switchable home). Omitted when mounted top. */
  link?: ContextSlotLink | undefined;
  spell: ContextSlotSpell | null;
}

export function DesktopContextSlot({ link, spell }: DesktopContextSlotProps) {
  const occupant = link?.open ? (
    <DesktopLinkForm
      title={link.title}
      url={link.url}
      onChangeTitle={link.onChangeTitle}
      onChangeUrl={link.onChangeUrl}
      onSubmit={link.onSubmit}
      onCancel={link.onCancel}
    />
  ) : spell ? (
    <SpellSuggestionBar
      word={spell.word}
      suggestions={spell.suggestions}
      onPick={spell.onPick}
      onAddToDictionary={spell.onAddToDictionary}
    />
  ) : null;

  if (!occupant) return null; // empty → not rendered → zero space, no page jump
  return <div className="editor__context-slot" role="group" aria-label="Context tools">{occupant}</div>;
}
