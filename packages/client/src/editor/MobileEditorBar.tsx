import { useState } from 'react';
import type { ComponentType } from 'react';
import { Undo, Redo, BulletList, Plus } from '../icons/index.js';
import type { IconProps } from '../icons/index.js';
import { toolsFor } from './editorTools.js';
import type { ToolDescriptor, ToolGroup } from './editorTools.js';
import type { EditorActiveState } from './editorState.js';
import { useKeyboardInset } from '../lib/useKeyboardInset.js';

// Float-above-keyboard is ON by default (task #66); ?kbfloat=off reverts to the layout-bottom sticky bar
// so Jim can A/B the screen-real-estate tradeoff on the live site without a build change.
function floatEnabledFromUrl(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('kbfloat') !== 'off';
}

interface MobileEditorBarProps {
  active: EditorActiveState;
  run: (tool: ToolDescriptor) => void;
  onUndo: () => void;
  onRedo: () => void;
}

type ActiveGroup = ToolGroup | null;

// Main-row group toggles (spec §3): Aa=style, B=format, ☰=lists, +=insert. Aa/B are styled text
// glyphs; lists/insert are icons. The active group's control turns --accent.
interface GroupToggle { group: ToolGroup; label: string; glyph?: string; icon?: ComponentType<IconProps> }
const GROUP_TOGGLES: readonly GroupToggle[] = [
  { group: 'style',  label: 'Style',  glyph: 'Aa' },
  { group: 'format', label: 'Format', glyph: 'B' },
  { group: 'lists',  label: 'Lists',  icon: BulletList },
  { group: 'insert', label: 'Insert', icon: Plus },
];

/**
 * Mobile grouped contextual bar (spec §3). Pinned to the bottom of the note sub-screen. Two rows:
 *  - sub-row (conditional, ABOVE main): the active group's controls, rendered FROM the registry
 *    (toolsFor('mobile', group)) — same commands as desktop, no duplicate logic.
 *  - main row: the 4 group toggles + a divider + persistent Undo/Redo (disabled-reflecting).
 * Tapping a group opens its sub-row; tapping the same group closes it; a different group swaps it.
 * activeGroup is ephemeral component-local state (not persisted, not in a store).
 */
export function MobileEditorBar({ active, run, onUndo, onRedo }: MobileEditorBarProps) {
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>(null);
  const toggleGroup = (g: ToolGroup) => setActiveGroup((cur) => (cur === g ? null : g));
  const subTools = activeGroup ? toolsFor('mobile', activeGroup) : [];

  // #66: float the bar just above the soft keyboard. When floating, the bar is fixed to the layout
  // bottom and lifted by the keyboard overlap (translateY); the slim main row stays reachable while
  // typing and the sub-row still grows UPWARD on demand. ?kbfloat=off keeps the old sticky bar.
  const [floatEnabled] = useState(floatEnabledFromUrl);
  const keyboardInset = useKeyboardInset();
  const lifted = floatEnabled && keyboardInset > 0;
  const className =
    `editor__mbar${floatEnabled ? ' editor__mbar--floating' : ''}${lifted ? ' editor__mbar--lifted' : ''}`;
  const style = floatEnabled ? { transform: `translateY(-${keyboardInset}px)` } : undefined;

  return (
    <div className={className} style={style}>
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
