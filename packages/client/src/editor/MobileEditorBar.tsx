import { useState } from 'react';
import { Undo, Redo } from '../icons/index.js';
import { toolsFor, GROUP_TOGGLES } from './editorTools.js';
import type { ToolDescriptor, ToolGroup } from './editorTools.js';
import type { EditorActiveState } from './editorState.js';

interface MobileEditorBarProps {
  active: EditorActiveState;
  run: (tool: ToolDescriptor) => void;
  onUndo: () => void;
  onRedo: () => void;
  /**
   * Layout variant. 'bottom' (default) = the sticky bottom sub-screen bar (native-keyboard non-touch case).
   * 'deck' = the SAME controls laid out as a compact single row for the Deck's native-mode TOP bar (the
   * bottom bar's content becomes the Deck top-bar toolbar while a note is open — Jim's context-aware Deck
   * correction). Only a modifier class differs; the two-row registry/active-state/undo-redo wiring is shared.
   */
  variant?: 'bottom' | 'deck';
}

type ActiveGroup = ToolGroup | null;

/**
 * Mobile grouped contextual bar (spec §3). Two rows:
 *  - sub-row (conditional, ABOVE main): the active group's controls, rendered FROM the registry
 *    (toolsFor('mobile', group)) — same commands as desktop, no duplicate logic.
 *  - main row: the 4 group toggles + a divider + persistent Undo/Redo (disabled-reflecting).
 * Tapping a group opens its sub-row; tapping the same group closes it; a different group swaps it.
 * activeGroup is ephemeral component-local state (not persisted, not in a store).
 *
 * Two homes for the SAME component (variant prop):
 *  - 'bottom' — pinned to the bottom of the note sub-screen (native keyboard, no Deck: a hardware-keyboard
 *    narrow window).
 *  - 'deck' — the Deck's native-mode TOP bar while a note is open (touch-first, native keyboard). The
 *    editor publishes this as its Deck loadout instead of the nav loadout (context-aware Deck).
 */
export function MobileEditorBar({ active, run, onUndo, onRedo, variant = 'bottom' }: MobileEditorBarProps) {
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>(null);
  const toggleGroup = (g: ToolGroup) => setActiveGroup((cur) => (cur === g ? null : g));
  const subTools = activeGroup ? toolsFor('mobile', activeGroup) : [];

  return (
    <div className={`editor__mbar${variant === 'deck' ? ' editor__mbar--deck' : ''}`}>
      {activeGroup && (
        <div className="editor__mbar-sub" role="toolbar" aria-label={`${activeGroup} tools`}>
          {subTools.map((tool) => {
            const on = tool.isActive(active);
            const Icon = tool.icon;
            return (
              <button
                key={`${tool.group}:${tool.id}`}
                type="button"
                className={`editor__mtool${on ? ' is-active' : ''}`}
                aria-label={tool.label}
                aria-pressed={on}
                onMouseDown={(e) => { e.preventDefault(); run(tool); }}
              >
                {tool.render === 'icon' && Icon
                  ? <Icon size={20} />
                  : <span className={`editor__tool-glyph editor__tool-glyph--${tool.id}`}>{tool.glyph ?? tool.label}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="editor__mbar-main">
        <div className="editor__mbar-groups">
          {GROUP_TOGGLES.map((gt) => {
            const on = activeGroup === gt.group;
            const Icon = gt.icon;
            return (
              <button
                key={gt.group}
                type="button"
                className={`editor__mgroup${on ? ' is-active' : ''}`}
                aria-label={gt.label}
                aria-pressed={on}
                onMouseDown={(e) => { e.preventDefault(); toggleGroup(gt.group); }}
              >
                {Icon
                  ? <Icon size={22} />
                  : <span className={`editor__mgroup-glyph editor__mgroup-glyph--${gt.group}`}>{gt.glyph}</span>}
              </button>
            );
          })}
        </div>

        <div className="editor__mbar-history">
          <span className="editor__mbar-divider" aria-hidden />
          <button type="button" className="editor__mtool" aria-label="Undo" disabled={!active.canUndo}
            onMouseDown={(e) => { e.preventDefault(); onUndo(); }}>
            <Undo size={22} />
          </button>
          <button type="button" className="editor__mtool" aria-label="Redo" disabled={!active.canRedo}
            onMouseDown={(e) => { e.preventDefault(); onRedo(); }}>
            <Redo size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
