/**
 * Content-presence plugin activation (#123 lazy plugins) — regression for the "media previews never load"
 * bug. OPENING a note that CONTAINS a lazy plugin block (an attachment/image) must load that plugin's runtime
 * so its island NodeView registers and the block renders for real. Before the fix, the ONLY caller of
 * loadRuntime was the attachment DROP handler (on insert), so an opened/reloaded note rendered every existing
 * attachment as the generic "Unknown block" placeholder forever. These tests assert the editor now loads the
 * runtime for a plugin type PRESENT in the opened doc — and does not for a plain-text note.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';
import { pluginRegistry } from '../src/plugins/runtime/index.js';
import { registerPluginIsland } from '../src/editor/nodeviews/PluginIsland.js';

// A spine body holding one attachment plugin block — spineToPmDoc turns an unknown/plugin block type into a
// plugin_block atom, so the editor's content-presence scan finds pluginType 'attachment'.
const attachmentBody = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'attachment',
    content: { hash: 'a'.repeat(64), name: 'pic.png', mime: 'image/png', size: 12 },
  },
];

function mount(noteId: string, initialBody: unknown) {
  return render(
    <MemoryRouter>
      <DeckHostProvider enabled>
        <ProseMirrorEditor
          noteId={noteId}
          initialTitle="T"
          initialBody={initialBody as never}
          onChange={() => {}}
        />
      </DeckHostProvider>
    </MemoryRouter>,
  );
}

describe('content-presence plugin activation (open a note that HAS a lazy plugin block)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the runtime for a plugin block present in the opened doc', async () => {
    // Mock so the real (heavy) dynamic import never runs — we only assert the activation FIRES.
    const spy = vi.spyOn(pluginRegistry, 'loadRuntime').mockResolvedValue(null);
    mount('note-attach', attachmentBody);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('attachment'));
  });

  it('does NOT load any runtime for a note with no plugin blocks', async () => {
    const spy = vi.spyOn(pluginRegistry, 'loadRuntime').mockResolvedValue(null);
    mount('note-plain', []);
    await new Promise((r) => setTimeout(r, 20)); // let the async activation run a tick
    expect(spy).not.toHaveBeenCalled();
  });

  it('upgrades the placeholder to the real island once the runtime registers (the setProps refresh)', async () => {
    // Distinct plugin type (not 'attachment') so registering its island never pollutes the other tests. The
    // mock registers a recognizable stub island when the runtime loads, mirroring the real loadRuntime.
    const shardBody = [
      { id: '33333333-3333-4333-8333-333333333333', type: 'testshard', content: { k: 1 } },
    ];
    vi.spyOn(pluginRegistry, 'loadRuntime').mockImplementation(async (id: string) => {
      registerPluginIsland(id, {
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'stub-island-live';
          dom.textContent = 'REAL';
          return { dom, stopEvent: () => true, ignoreMutation: () => true };
        },
      });
      return { islandFactories: {} } as never; // truthy runtime → editor re-sets nodeViews
    });
    const { container } = mount('note-upgrade', shardBody);
    // The generic placeholder is replaced by the real stub island after the content-presence refresh.
    await waitFor(() => expect(container.querySelector('.stub-island-live')).toBeTruthy());
    expect(container.querySelector('.editor-plugin-island--unknown')).toBeFalsy();
  });
});
