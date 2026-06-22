import { Fragment } from 'react';
import { TOOL_GROUPS, toolsFor } from './editorTools.js';
import type { ToolDescriptor } from './editorTools.js';
import type { EditorActiveState } from './editorState.js';

interface EditorToolbarProps {
  active: EditorActiveState;
  /** Run a tool's command on the view + refocus — owned by ProseMirrorEditor (holds the view). */
  run: (tool: ToolDescriptor) => void;
}

interface ToolButtonProps {
  tool: ToolDescriptor;
  active: EditorActiveState;
  run: (tool: ToolDescriptor) => void;
}

function ToolButton({ tool, active, run }: ToolButtonProps) {
  const on = tool.isActive(active);
  const disabled = tool.isEnabled ? !tool.isEnabled(active) : false;
  const Icon = tool.icon;
  return (
    <button
      type="button"
      className={`editor__tool${on ? ' is-active' : ''}`}
      aria-label={tool.label}
      aria-pressed={on}
      title={tool.label}
      disabled={disabled}
      // mouseDown + preventDefault (NOT click): keep the editor selection alive so the command runs
      // against the user's actual selection; run() refocuses the view afterwards.
      onMouseDown={(e) => { e.preventDefault(); run(tool); }}
    >
      {tool.render === 'icon' && Icon
        ? <Icon size={18} />
        : <span className={`editor__tool-glyph editor__tool-glyph--${tool.id}`}>{tool.glyph ?? tool.label}</span>}
    </button>
  );
}

/**
 * Desktop formatting toolbar — one flat wrapping row rendered FROM the tool-descriptor registry
 * (editorTools.ts), the single source both surfaces share. Four groups (style·format·lists·insert) in
 * order, each separated by a 1px×18px hairline divider (spec §2). No hardcoded button list lives here.
 */
export function EditorToolbar({ active, run }: EditorToolbarProps) {
  return (
    <div className="editor__fmtbar" role="toolbar" aria-label="Formatting">
      {TOOL_GROUPS.map((group, gi) => {
        const tools = toolsFor('desktop', group);
        if (tools.length === 0) return null;
        return (
          <Fragment key={group}>
            {gi > 0 && <span className="editor__fmtbar-divider" aria-hidden />}
            {tools.map((tool) => (
              <ToolButton key={`${tool.group}:${tool.id}`} tool={tool} active={active} run={run} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
