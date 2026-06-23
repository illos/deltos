import { EditorGroupSelector, EditorGroupSubmenu } from './editorLoadoutTools.js';
import type { DeckGroup } from './editorLoadoutTools.js';
import { DesktopLinkForm } from './DesktopLinkForm.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';

/**
 * EditorControlStrip (#69 desktop Deck) — the DESKTOP render target of the editor loadout: the same
 * control registry as the mobile Deck (EditorGroupSelector + EditorGroupSubmenu), rendered INLINE as a
 * top-anchored sticky strip — MINUS the keypad layer (desktop has a real keyboard) and minus the mic / the
 * show-hide toggle (no keypad to dictate into or collapse). This replaces the old flat Deploy-3
 * EditorToolbar: same tools, now via the Deck's selector→submenu model. "One registry, two render targets":
 * mobile publishes the keypad loadout to the shell Deck; desktop renders these control layers here.
 *
 * The link tool opens an inline URL+Title form (DesktopLinkForm, native <input>s) in the submenu row.
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
  activeGroup: DeckGroup | null;
  toggleGroup: (g: DeckGroup) => void;
  active: EditorActiveState;
  onUndo: () => void;
  onRedo: () => void;
  runTool: (tool: ToolDescriptor) => void;
  link: ControlStripLink;
}

export function EditorControlStrip({
  activeGroup, toggleGroup, active, onUndo, onRedo, runTool, link,
}: EditorControlStripProps) {
  return (
    <div className="editor__deck-strip">
      {/* Selector row: group buttons (Style/Format/+) + Undo·Redo. No mic, no keypad toggle (desktop). */}
      <div className="editor__deck-strip-row editor__deck-strip-row--selector">
        <EditorGroupSelector
          activeGroup={activeGroup}
          toggleGroup={toggleGroup}
          active={active}
          onUndo={onUndo}
          onRedo={onRedo}
        />
      </div>
      {/* Expansion row: the link form takes precedence over an open group's submenu (it's a modal action). */}
      {link.open ? (
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
      ) : activeGroup ? (
        <div className="editor__deck-strip-row editor__deck-strip-row--sub">
          <EditorGroupSubmenu activeGroup={activeGroup} active={active} run={runTool} />
        </div>
      ) : null}
    </div>
  );
}
