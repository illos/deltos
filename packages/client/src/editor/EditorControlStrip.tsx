import { Fragment } from 'react';
import { DECK_GROUPS, toolsForDeckGroup } from './editorLoadoutTools.js';
import { Undo, Redo } from '../icons/index.js';
import { DesktopLinkForm } from './DesktopLinkForm.js';
import { SpellSuggestionBar } from './SpellSuggestionBar.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';

/**
 * EditorControlStrip (#69 desktop Deck) — the DESKTOP render target of the editor loadout: the SAME
 * converged tool registry as the mobile Deck (DECK_GROUPS / toolsForDeckGroup), rendered for desktop's
 * width — FLAT and EXPANDED (all tools visible inline; Jim's pick) — MINUS the keypad / mic / show-hide
 * toggle. Replaces the old flat EditorToolbar: one registry, two render targets.
 *
 * Top-anchored orientation (reversed vs the bottom-anchored mobile Deck): the primary controls are the TOP
 * row; a CONTEXT sub-row sits BELOW (grows down into the note). The context row is the desktop render of the
 * mobile Deck's top-slot-occupant model — link form (when adding a link) | spell suggestion bar (when on a
 * misspelling) | empty — and is ALWAYS RESERVED at a constant height so appearing/clearing an occupant never
 * reflows the page (same no-jump invariant as the mobile Deck's reserved band).
 */
export interface ControlStripLink {
  open: boolean;
  title: string;
  url: string;
  onChangeTitle: (v: string) => void;
  onChangeUrl: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export interface ControlStripSpell {
  word: string;
  suggestions: string[];
  onPick: (word: string) => void;
  onAddToDictionary: () => void;
}

interface EditorControlStripProps {
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
  runTool: (tool: ToolDescriptor) => void;
  link: ControlStripLink;
  /** Active misspelling suggestions → rendered in the context row (desktop's bar, not a popover). */
  spell: ControlStripSpell | null;
}

function StripTool({ tool, active, run }: { tool: ToolDescriptor; active: EditorActiveState; run: (t: ToolDescriptor) => void }) {
  const on = tool.isActive(active);
  const Icon = tool.icon;
  return (
    <button
      type="button"
      className={`editor__mtool${on ? ' is-active' : ''}`}
      aria-label={tool.label}
      aria-pressed={on}
      title={tool.label}
      onPointerDown={(e) => { e.preventDefault(); run(tool); }}
    >
      {tool.render === 'icon' && Icon
        ? <Icon size={18} />
        : <span className={`editor__tool-glyph editor__tool-glyph--${tool.id}`}>{tool.glyph ?? tool.label}</span>}
    </button>
  );
}

export function EditorControlStrip({ active, onUndo, onRedo, runTool, link, spell }: EditorControlStripProps) {
  return (
    <div className="editor__deck-strip">
      {/* Primary controls (top row): every group's tools expanded inline, hairline-divided, Undo/Redo right. */}
      <div className="editor__deck-strip-row editor__deck-strip-row--flat" role="toolbar" aria-label="Formatting">
        {DECK_GROUPS.map((group, gi) => (
          <Fragment key={group.group}>
            {gi > 0 && <span className="editor__deck-strip-divider" aria-hidden />}
            {toolsForDeckGroup(group.group).map((tool) => (
              <StripTool key={`${tool.group}:${tool.id}`} tool={tool} active={active} run={runTool} />
            ))}
          </Fragment>
        ))}
        <div className="editor__deck-strip-history">
          <button type="button" className="editor__mtool" aria-label="Undo" disabled={!active.canUndo}
            onPointerDown={(e) => { e.preventDefault(); onUndo(); }}>
            <Undo size={18} />
          </button>
          <button type="button" className="editor__mtool" aria-label="Redo" disabled={!active.canRedo}
            onPointerDown={(e) => { e.preventDefault(); onRedo(); }}>
            <Redo size={18} />
          </button>
        </div>
      </div>
      {/* Context row — ALWAYS reserved (constant height → no page jump), filled conditionally. */}
      <div className="editor__deck-strip-context">
        {link.open ? (
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
        ) : null}
      </div>
    </div>
  );
}
