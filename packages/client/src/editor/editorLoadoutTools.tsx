import { useRef, useState } from 'react';
import { Undo, Redo, Plus, Mic } from '../icons/index.js';
import { toolsFor } from './editorTools.js';
import type { ToolDescriptor, ToolGroup } from './editorTools.js';
import type { EditorActiveState } from './editorState.js';

/**
 * The editor loadout's TOOL UI (#69 editor-loadout v1) — the Deploy-3 tool registry, ASSEMBLED (not
 * redesigned) into the Deck's layers, host-injected into the generic core KeypadLoadout (selector in the
 * base region; per-group submenu in the topSlot). Deck core stays editor-agnostic.
 *
 * §6.1 Option B — the DECK selector COMPOSES a 3-toggle row over the SHARED registry (no registry mutation;
 * desktop keeps its 4 groups): Style · Format · "+" (Plus = lists + the other inserts, merged) — freeing a
 * slot for the first-class MIC control. The submenu for "+" flat-maps toolsFor('lists') + toolsFor('insert').
 */

/** The Deck selector's composed groups → which registry ToolGroups each presents. */
type DeckGroup = 'style' | 'format' | 'plus';
interface DeckGroupDef { group: DeckGroup; label: string; glyph?: string; icon?: typeof Plus; tools: ToolGroup[] }
const DECK_GROUPS: readonly DeckGroupDef[] = [
  { group: 'style',  label: 'Style',  glyph: 'Aa', tools: ['style'] },
  { group: 'format', label: 'Format', glyph: 'B',  tools: ['format'] },
  { group: 'plus',   label: 'Insert', icon: Plus,  tools: ['lists', 'insert'] }, // Lists merged into "+"
];
const toolsForDeckGroup = (g: DeckGroup): ToolDescriptor[] =>
  (DECK_GROUPS.find((d) => d.group === g)?.tools ?? []).flatMap((tg) => toolsFor('mobile', tg));

/** Owns the open-group state. Sticky: tap to open, same to close, another to switch. */
export function useEditorLoadoutTools() {
  const [activeGroup, setActiveGroup] = useState<DeckGroup | null>(null);
  const toggleGroup = (g: DeckGroup) => setActiveGroup((cur) => (cur === g ? null : g));
  return { activeGroup, toggleGroup };
}

const MIC_LONG_PRESS_MS = 350;

/** Mic control (§6.1) — mirrors the show/hide grammar: TAP = toggle voice mode; LONG-PRESS = hold-to-talk
 *  (record while held, release anywhere → stop; the release is on window since the mic unmounts when the
 *  voice loadout swaps in). */
function MicButton({ recording, onTap, onHoldStart, onHoldEnd }: {
  recording: boolean;
  onTap: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return (
    <button
      type="button"
      className={`editor__mtool elt-mic${recording ? ' is-active' : ''}`}
      aria-label={recording ? 'Recording — tap Stop in the panel' : 'Voice dictation'}
      aria-pressed={recording}
      onPointerDown={(e) => {
        e.preventDefault();
        held.current = false;
        timer.current = setTimeout(() => {
          held.current = true;
          onHoldStart();
          const end = () => {
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            onHoldEnd();
          };
          window.addEventListener('pointerup', end);
          window.addEventListener('pointercancel', end);
        }, MIC_LONG_PRESS_MS);
      }}
      onPointerUp={(e) => { e.preventDefault(); clear(); if (!held.current) onTap(); }}
      onPointerLeave={() => { if (!held.current) clear(); }}
    >
      <Mic size={22} />
    </button>
  );
}

interface MicProps { recording: boolean; onTap: () => void; onHoldStart: () => void; onHoldEnd: () => void }

interface SelectorProps {
  activeGroup: DeckGroup | null;
  toggleGroup: (g: DeckGroup) => void;
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
  /** When voice is available, the mic control (§6.1). undefined = no mic (e.g. capture unsupported). */
  mic?: MicProps | undefined;
}

/**
 * The selector row — base region BELOW the keys, always present. Groups left, then the Mic, then Undo/Redo.
 * pointerdown + preventDefault keeps the editor focused (the Deck also swallows at the container).
 */
export function EditorGroupSelector({ activeGroup, toggleGroup, active, onUndo, onRedo, mic }: SelectorProps) {
  return (
    <>
      <div className="elt-groups" role="toolbar" aria-label="Formatting groups">
        {DECK_GROUPS.map((gt) => {
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
        {mic && <MicButton {...mic} />}
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
  activeGroup: DeckGroup | null;
  active: EditorActiveState;
  run: (tool: ToolDescriptor) => void;
}

/**
 * The per-group submenu — the active group's controls ABOVE the keys. Null when no group is open. For "+"
 * it presents lists + inserts together (Option B composition over the shared registry); isActive reflects
 * the live selection.
 */
export function EditorGroupSubmenu({ activeGroup, active, run }: SubmenuProps) {
  if (!activeGroup) return null;
  const tools = toolsForDeckGroup(activeGroup);
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

/** Exposed for tests: the composed group set + their registry tools. */
export { DECK_GROUPS, toolsForDeckGroup };
export type { DeckGroup };
