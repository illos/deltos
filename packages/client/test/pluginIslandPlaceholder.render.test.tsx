/**
 * #123 A1 §6 — the friendlier unknown-block placeholder. A plugin_block whose runtime isn't active here
 * (code absent / version skew / a lazy runtime not yet loaded) renders a placeholder, LOSSLESSLY (the
 * opaque payload in node.attrs is never touched). A recognized type (manifest hit) shows its NAME; an
 * unrecognized type shows "Unknown block [type]".
 */
import { describe, it, expect } from 'vitest';
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { UnknownPluginIslandView, buildPluginIslandNodeViews } from '../src/editor/nodeviews/PluginIsland.js';
import { deltoSchema } from '../src/editor/schema.js';

function fakeBlock(pluginType: string, payload: Record<string, unknown> = { keep: 'me' }): PmNode {
  return { attrs: { pluginType, pluginContent: payload } } as unknown as PmNode;
}

describe('#123 friendly unknown-block placeholder', () => {
  it('names a recognized plugin and marks it --named (calmer, not an error)', () => {
    const view = new UnknownPluginIslandView(fakeBlock('link_card'), 'Link card');
    expect(view.dom.textContent).toBe('Link card');
    expect(view.dom.className).toContain('editor-plugin-island--named');
    expect(view.dom.getAttribute('data-plugin-type')).toBe('link_card');
  });

  it('shows "Unknown block [type]" for an unrecognized type (no name)', () => {
    const view = new UnknownPluginIslandView(fakeBlock('mystery'));
    expect(view.dom.textContent).toBe('Unknown block [mystery]');
    expect(view.dom.className).not.toContain('--named');
  });

  it('is LOSSLESS — never reads or mutates the opaque payload', () => {
    const node = fakeBlock('mystery', { url: 'x', nested: { a: 1 } });
    const before = JSON.stringify(node.attrs.pluginContent);
    new UnknownPluginIslandView(node);
    expect(JSON.stringify(node.attrs.pluginContent)).toBe(before);
  });

  it('buildPluginIslandNodeViews wires the resolveName lookup into the fallback', () => {
    const views = buildPluginIslandNodeViews(deltoSchema, (t) => (t === 'known' ? 'Known Thing' : undefined));
    const make = views['plugin_block'];
    expect(make).toBeDefined();
    const nodeView = make!(fakeBlock('known'), {} as unknown as EditorView, () => 0);
    expect((nodeView.dom as HTMLElement).textContent).toBe('Known Thing');
  });
});
