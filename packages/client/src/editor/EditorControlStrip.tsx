import { Fragment } from 'react';
import { DECK_GROUPS, toolsForDeckGroup } from './editorLoadoutTools.js';
import { Undo, Redo } from '../icons/index.js';
import { DesktopLinkForm } from './DesktopLinkForm.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';

/**
 * EditorControlStrip (#69 desktop Deck) — the DESKTOP render target of the editor loadout: the SAME
 * converged tool registry as the mobile Deck (DECK_GROUPS / toolsForDeckGroup), rendered for desktop's
 * width — FLAT and EXPANDED (all tools visible inline across the top strip, no click-to-expand collapse;
 * Jim's pick) — MINUS the keypad layer + mic + show/hide toggle. This replaces the old flat EditorToolbar:
 * one registry, two render targets (mobile = keypad loadout in the shell Deck; desktop = this strip).
 *
 * Top-anchored slot orientation (reversed vs the bottom-anchored mobile Deck): the primary controls are the
 * TOP row; the link form (the one overflow surface) grows DOWNWARD below it into the note.
 *
 * The link tool opens an inline URL+Title form (DesktopLinkForm, native <input>s — desktop has a real
 * keyboard; the keypad-fed buffer is mobile-only).
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

interface EditorControlStripProps {
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
  runTool: (tool: ToolDescriptor) => void;
  link: ControlStripLink;
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

export function EditorControlStrip({ active, onUndo, onRedo, runTool, link }: EditorControlStripProps) {
  return (
    <div className="editor__deck-strip">
      {/* Primary controls (top row): every group's tools expanded inline, hairline-divided, with Undo/Redo
          pushed to the right. The same converged registry as the mobile Deck. */}
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
      {/* The link form grows DOWNWARD into the note (top-anchored orientation). */}
      {link.open && (
        <div className="editor__deck-strip-row editor__deck-strip-row--sub">
          <DesktopLinkForm
            title={link.title}
            url={link.url}
            onChangeTitle={link.onChangeTitle}
            onChangeUrl={link.onChangeUrl}
            onSubmit={link.onSubmit}
            onCancel={link.onCancel}
          />
        </div>
      )}
    </div>
  );
}
