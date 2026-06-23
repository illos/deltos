import { Fragment } from 'react';
import { DECK_GROUPS, toolsForDeckGroup } from './editorLoadoutTools.js';
import { Undo, Redo } from '../icons/index.js';
import { DesktopLinkForm } from './DesktopLinkForm.js';
import type { ContextSlotLink } from './DesktopContextSlot.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';

/**
 * EditorControlStrip (#69 desktop Deck) — the desktop Deck's sticky TOP control strip: the SAME converged
 * tool registry as the mobile Deck (DECK_GROUPS / toolsForDeckGroup), rendered for desktop's width — FLAT
 * and EXPANDED (all tools visible inline; Jim's pick) — MINUS the keypad / mic / show-hide toggle. Replaces
 * the old flat EditorToolbar: one registry, two render targets (mobile = keypad loadout in the shell Deck).
 *
 * Full-bleed band (CSS); inner rows re-center to the note content column. Spell suggestions live in the
 * separate bottom context slot (DesktopContextSlot). The LINK FORM mounts HERE by default — a transient row
 * under the toolbar, right by its trigger button, rendered ONLY while adding a link (not reserved, so no
 * idle space; the brief push-down is user-triggered). It's switchable to the bottom slot via the host's
 * LINK_FORM_AT_BOTTOM flag (then `link` is omitted here).
 */
interface EditorControlStripProps {
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
  runTool: (tool: ToolDescriptor) => void;
  /** The link form, when mounted under the toolbar. Omitted when the host mounts it in the bottom slot. */
  link?: ContextSlotLink | undefined;
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
      {/* Transient link-entry row, right under the toolbar by its button — only while adding a link. */}
      {link?.open && (
        <div className="editor__deck-strip-linkrow">
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
