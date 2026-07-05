/**
 * Step-2 presence gate at the FULL EDITOR (formula-engine.md §8; plugins-lazy-past-first-paint): opening
 * a note through ProseMirrorEditor loads the formula environment chunk ONLY when the note actually
 * contains an engine-managed formula. The environment module is vi.mock-ed, so the broker's real dynamic
 * `import()` is observable without pulling the real engine into the test.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';

const envFactory = vi.fn(() => ({ add: vi.fn(), update: vi.fn(), remove: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/plugins/formula/formulaEnvironment.js', () => ({
  createFormulaEnvironment: (): unknown => envFactory(),
}));

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

describe('presence gate — formula environment loads only on formula presence', () => {
  afterEach(() => {
    cleanup();
    envFactory.mockClear();
  });

  it('a formula-free note performs NO environment import/work', async () => {
    mount('note-plain', [
      { id: '11111111-1111-4111-8111-111111111111', type: 'paragraph', content: { segments: [{ text: 'plain note, no formulas' }] } },
    ]);
    await new Promise((r) => setTimeout(r, 25)); // give a would-be import every chance to land
    expect(envFactory).not.toHaveBeenCalled();
  });

  it('a note CONTAINING a formula builds the environment on open', async () => {
    mount('note-math', [
      { id: '22222222-2222-4222-8222-222222222222', type: 'paragraph', content: { segments: [{ text: '1 + 1', formula: { type: 'math', state: null } }] } },
    ]);
    await waitFor(() => expect(envFactory).toHaveBeenCalledTimes(1));
  });

  it('a note whose only chip is NON-engine (hexcolor) stays gated too', async () => {
    mount('note-hex', [
      { id: '33333333-3333-4333-8333-333333333333', type: 'paragraph', content: { segments: [{ text: '#ff5733', formula: { type: 'hexcolor', state: null } }] } },
    ]);
    await new Promise((r) => setTimeout(r, 25));
    expect(envFactory).not.toHaveBeenCalled();
  });
});
