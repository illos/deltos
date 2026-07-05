/**
 * InfoPanel — rendered-UI gate (ui-features-need-rendered-ui-gate). Mounts the component and asserts the DOM:
 *   - a TEXT note shows the common rows (Created / Edited / Notebook / Words / Characters / Sync) and NO
 *     file-specific rows;
 *   - a FILE note ADDS the file rows (Filename with a rename affordance / Type / Size / Download);
 *   - the notebook name resolves via useNotebooks, falling back to "All Notes" for a null notebookId;
 *   - a filename rename persists through onSave with the attachment `name` + note.title updated.
 *
 * blobClient (the Download blob path) is never mounted here (Download isn't clicked), so no network/worker.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import type { Note } from '@deltos/shared';

const hoisted = vi.hoisted(() => ({ notebooks: [] as { id: string; name: string }[] }));
vi.mock('../db/storeHooks.js', () => ({ useNotebooks: () => hoisted.notebooks }));

import { InfoPanel } from './InfoPanel.js';

const UUID = '33333333-3333-4333-8333-333333333333';

function textNote(overrides: Partial<Note> = {}): Note {
  return {
    id: UUID as Note['id'],
    title: 'Hello world',
    notebookId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 4,
    syncStatus: 'synced',
    properties: {},
    body: [{ id: 'b1', type: 'paragraph', content: { segments: [{ text: 'one two three' }] } }] as Note['body'],
    ...overrides,
  } as Note;
}

function fileNote(overrides: Partial<Note> = {}): Note {
  return textNote({
    title: 'Q3-report.pdf',
    properties: { fileType: { type: 'text', value: 'file' } } as Note['properties'],
    body: [{ id: 'b1', type: 'attachment', content: { hash: 'h', name: 'Q3-report.pdf', mime: 'application/pdf', size: 2048 } }] as Note['body'],
    ...overrides,
  });
}

function rowValue(dt: string): string {
  // The dt/dd rows are `.file-view__meta-row` divs; find the one whose dt matches and read its dd.
  const dtEl = screen.getByText(dt);
  const dd = dtEl.parentElement!.querySelector('dd')!;
  return dd.textContent ?? '';
}

afterEach(() => { cleanup(); hoisted.notebooks = []; });

describe('InfoPanel — common + file rows', () => {
  it('a TEXT note shows the common rows and NO file rows', () => {
    render(<InfoPanel note={textNote()} onBack={() => {}} onSave={async () => {}} />);

    expect(screen.getByRole('heading', { name: 'Info' })).not.toBeNull();
    expect(screen.getByText('Created')).not.toBeNull();
    expect(screen.getByText('Edited')).not.toBeNull();
    expect(rowValue('Notebook')).toBe('All Notes');
    // noteText joins title + body: "Hello world one two three" → 5 words.
    expect(rowValue('Words')).toBe('5');
    expect(Number(rowValue('Characters'))).toBeGreaterThan(0);
    expect(rowValue('Sync')).toBe('synced');

    // No file-specific rows on a text note.
    expect(screen.queryByText('Filename')).toBeNull();
    expect(screen.queryByText('Download')).toBeNull();
    expect(screen.queryByText('Size')).toBeNull();
  });

  it('resolves the notebook name via useNotebooks', () => {
    hoisted.notebooks = [{ id: 'nb-1', name: 'Work' }];
    render(<InfoPanel note={textNote({ notebookId: 'nb-1' as Note['notebookId'] })} onBack={() => {}} onSave={async () => {}} />);
    expect(rowValue('Notebook')).toBe('Work');
  });

  it('a FILE note ADDS the file rows (Filename / Type / Size / Download)', () => {
    render(<InfoPanel note={fileNote()} onBack={() => {}} onSave={async () => {}} />);

    expect(screen.getByText('Filename')).not.toBeNull();
    expect(rowValue('Type')).toBe('application/pdf');
    expect(rowValue('Size')).toBe('2.0 KB');
    expect(screen.getByRole('button', { name: 'Download file' })).not.toBeNull();
    // Filename shows the attachment name as a rename trigger.
    expect(screen.getByRole('button', { name: 'Q3-report.pdf' })).not.toBeNull();
  });

  it('renaming a file persists the new name through onSave (attachment name + title)', async () => {
    const saved: Note[] = [];
    render(<InfoPanel note={fileNote()} onBack={() => {}} onSave={async (n) => { saved.push(n); }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Q3-report.pdf' }));
    const input = screen.getByLabelText('Filename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'renamed.pdf' } });
    fireEvent.submit(input.closest('form')!);

    // Let the async submitRename resolve.
    await Promise.resolve();
    expect(saved).toHaveLength(1);
    const next = saved[0]!;
    expect(next.title).toBe('renamed.pdf');
    expect((next.body[0]!.content as { name: string }).name).toBe('renamed.pdf');
    expect(next.syncStatus).toBe('pending');
  });

  it('the Info heading + back button render (mirrors HistoryPanel shell)', () => {
    render(<InfoPanel note={textNote()} onBack={() => {}} onSave={async () => {}} />);
    const header = screen.getByRole('heading', { name: 'Info' }).parentElement!;
    expect(within(header).getByLabelText('Back to note')).not.toBeNull();
  });
});
