import { useState } from 'react';
import { Undo, Redo } from '../icons/index.js';
import { toolsFor, GROUP_TOGGLES } from './editorTools.js';
import type { ToolDescriptor, ToolGroup } from './editorTools.js';
import type { EditorActiveState } from './editorState.js';

/**
 * The editor loadout's TOOL UI (#69 editor-loadout v1, commit 2) — the Deploy-3 tool registry, ASSEMBLED
 * (not redesigned) into the Deck's layers. It is host-side (deltos-specific editor tools) and injected
 * into the generic core KeypadLoadout via its `baseExtra` (selector, below the keys) + `submenu` (the
 * active group's controls, above the keys) seams. Deck core stays editor-agnostic.
 *
 * Spatial layout intentionally diverges from the static mock (which stacked both above the keyboard,
 * because it couldn't touch the native keyboard): we own the stack now → selector BELOW the keys, submenu
 * ABOVE. Same TOOLS, our placement.
 *
 * The same group affordances + registry as MobileEditorBar (native-keyboard mode), so formatting behaves
 * identically in both modes — only the container differs.
 */

/** Owns the shared selection-of-group state. Sticky: tap a group to open it, the same to close, another
 *  to switch (Jim's call). Used by BOTH the selector and the submenu so they agree on the open group. */
export function useEditorLoadoutTools() {
  const [activeGroup, setActiveGroup] = useState<ToolGroup | null>(null);
  const toggleGroup = (g: ToolGroup) => setActiveGroup((cur) => (cur === g ? null : g));
  return { activeGroup, toggleGroup };
}

interface SelectorProps {
  activeGroup: ToolGroup | null;
  toggleGroup: (g: ToolGroup) => void;
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * The group-selector row — lives in the base region BELOW the keys, ALWAYS present (persists as the slim
 * bar when the keypad is collapsed = restyle mode). Groups left (flex-fill), Undo/Redo right; the
 * show/hide toggle (Deck core chrome) is appended after this by KeypadLoadout.
 *
 * pointerdown + preventDefault keeps the host editor focused (same model as the keypad keys), so a tap
 * never blurs the note / closes the Deck.
 */
export function EditorGroupSelector({ activeGroup, toggleGroup, active, onUndo, onRedo }: SelectorProps) {
  return (
    <>
      <div className="elt-groups" role="toolbar" aria-label="Formatting groups">
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
              onPointerDown={(e) => { e.preventDefault(); toggleGroup(gt.group); }}
            >
              {Icon
                ? <Icon size={22} />
                : <span className={`editor__mgroup-glyph editor__mgroup-glyph--${gt.group}`}>{gt.glyph}</span>}
            </button>
          );
        })}
      </div>
      <div className="elt-history">
        <button type="button" className="editor__mtool" aria-label="Undo" disabled={!active.canUndo}
          onPointerDown={(e) => { e.preventDefault(); onUndo(); }}>
          <Undo size={22} />
        </button>
        <button type="button" className="editor__mtool" aria-label="Redo" disabled={!active.canRedo}
          onPointerDown={(e) => { e.preventDefault(); onRedo(); }}>
          <Redo size={22} />
        </button>
      </div>
    </>
  );
}

interface SubmenuProps {
  activeGroup: ToolGroup | null;
  active: EditorActiveState;
  run: (tool: ToolDescriptor) => void;
}

/**
 * The per-group submenu — the active group's controls, rendered ABOVE the keys (it grows the Deck upward
 * into the note; the keys never move). Null when no group is open (keys + selector at rest). Tools render
 * FROM the registry (toolsFor('mobile', group)) — the 'mobile' surface so Link rides the Insert tray,
 * matching MobileEditorBar; isActive reflects the live selection.
 */
export function EditorGroupSubmenu({ activeGroup, active, run }: SubmenuProps) {
  if (!activeGroup) return null;
  const tools = toolsFor('mobile', activeGroup);
  return (
    <div className="elt-sub" role="toolbar" aria-label={`${activeGroup} tools`}>
      {tools.map((tool) => {
        const on = tool.isActive(active);
        const Icon = tool.icon;
        return (
          <button
            key={`${tool.group}:${tool.id}`}
            type="button"
            className={`editor__mtool${on ? ' is-active' : ''}`}
            aria-label={tool.label}
            aria-pressed={on}
            onPointerDown={(e) => { e.preventDefault(); run(tool); }}
          >
            {tool.render === 'icon' && Icon
              ? <Icon size={20} />
              : <span className={`editor__tool-glyph editor__tool-glyph--${tool.id}`}>{tool.glyph ?? tool.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
