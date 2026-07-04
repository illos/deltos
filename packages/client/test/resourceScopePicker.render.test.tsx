/**
 * ResourceScopePicker render tests (ROAD-0011 P1 lane 2, ui-features-need-rendered-ui-gate). Mounts the pure
 * picker and drives real DOM:
 *   RP-1  three modes render; default = Whole workspace → onChange([])
 *   RP-2  Pick notebooks → checkbox LIST; toggling a notebook emits {kind:'notebook'} (and un-toggle clears)
 *   RP-3  Pick notes → SEARCH select; a match adds as a chip → {kind:'note'}; removing the chip clears it
 *   RP-4  mixed selection: notebooks + notes are BOTH carried in the emitted resource set
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { screen, userEvent } from './renderHelpers.js';
import type { Resource } from '@deltos/shared';
import { ResourceScopePicker, type PickerNote } from '../src/components/ResourceScopePicker.js';

const NOTEBOOKS = [
  { id: 'nb-1', name: 'Work' },
  { id: 'nb-2', name: 'Personal' },
];
const NOTE_MATCHES: PickerNote[] = [
  { id: 'note-1', title: 'Grocery list' },
  { id: 'note-2', title: 'Grocery receipts' },
];

function mount(onChange: (r: Resource[]) => void, searchNotes = vi.fn(async () => NOTE_MATCHES)) {
  render(<ResourceScopePicker notebooks={NOTEBOOKS} searchNotes={searchNotes} onChange={onChange} />);
  return searchNotes;
}

/** The most recent resource set the picker emitted. */
function lastResources(onChange: ReturnType<typeof vi.fn>): Resource[] {
  return onChange.mock.calls.at(-1)?.[0] ?? [];
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ResourceScopePicker', () => {
  it('RP-1 — three modes; default whole-workspace emits []', async () => {
    const onChange = vi.fn();
    mount(onChange);
    expect(screen.getByLabelText('Whole workspace')).toBeTruthy();
    expect(screen.getByLabelText('Pick notebooks')).toBeTruthy();
    expect(screen.getByLabelText('Pick notes')).toBeTruthy();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastResources(onChange)).toEqual([]);
  });

  it('RP-2 — pick notebooks: toggling a notebook emits {kind:notebook}, un-toggle clears', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(onChange);

    await user.click(screen.getByLabelText('Pick notebooks'));
    await user.click(screen.getByLabelText('Notebook Work'));
    await waitFor(() => expect(lastResources(onChange)).toEqual([{ kind: 'notebook', id: 'nb-1' }]));

    await user.click(screen.getByLabelText('Notebook Work'));
    await waitFor(() => expect(lastResources(onChange)).toEqual([]));
  });

  it('RP-3 — pick notes: search match adds a chip → {kind:note}; removing the chip clears it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(onChange);

    await user.click(screen.getByLabelText('Pick notes'));
    await user.type(screen.getByLabelText('Search notes'), 'grocery');

    // The debounced search resolves → results render.
    const addBtn = await screen.findByLabelText('Add Grocery list');
    await user.click(addBtn);

    await waitFor(() => expect(lastResources(onChange)).toEqual([{ kind: 'note', id: 'note-1' }]));
    // The added note shows as a removable chip.
    expect(screen.getByLabelText('Remove Grocery list')).toBeTruthy();

    await user.click(screen.getByLabelText('Remove Grocery list'));
    await waitFor(() => expect(lastResources(onChange)).toEqual([]));
  });

  it('RP-4 — mixed: notebook + note are both carried in the emitted set', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(onChange);

    await user.click(screen.getByLabelText('Pick notebooks'));
    await user.click(screen.getByLabelText('Notebook Personal'));

    await user.click(screen.getByLabelText('Pick notes'));
    await user.type(screen.getByLabelText('Search notes'), 'grocery');
    await user.click(await screen.findByLabelText('Add Grocery list'));

    await waitFor(() =>
      expect(lastResources(onChange)).toEqual([
        { kind: 'notebook', id: 'nb-2' },
        { kind: 'note', id: 'note-1' },
      ]),
    );
  });
});
