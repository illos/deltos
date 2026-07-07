/**
 * ExportSection render test (ROAD-0017 / standing ui-features-need-rendered-ui-gate). Mounts the REAL
 * "Export" body (extracted from the old ExportPanel) over a mocked exportNote lib and proves the
 * user-visible contract:
 *   - "Export as Markdown" invokes exportMarkdown(note);
 *   - "Export as PDF" / "Print" both invoke the single printNote path;
 *   - when printNote reports { ok:false } (the iOS-PWA no-op) a VISIBLE fallback alert appears — never swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Note } from '@deltos/shared';

const { exportMarkdown, printNote, showToast } = vi.hoisted(() => ({
  exportMarkdown: vi.fn(async () => {}),
  printNote: vi.fn(async () => ({ ok: true })),
  showToast: vi.fn(),
}));
vi.mock('../lib/exportNote.js', () => ({ exportMarkdown, printNote }));
vi.mock('../lib/toastEvents.js', () => ({ showToast }));

import { ExportSection } from './ExportSection.js';

const NOTE = {
  id: 'note-1',
  title: 'Test note',
  notebookId: null,
  properties: {},
  body: [{ id: 'p', type: 'paragraph', content: { segments: [{ text: 'body' }] } }],
} as unknown as Note;

beforeEach(() => {
  vi.clearAllMocks();
  printNote.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('ExportSection', () => {
  it('Export as Markdown invokes exportMarkdown for the note', async () => {
    render(<ExportSection note={NOTE} />);
    fireEvent.click(screen.getByLabelText('Export as Markdown'));
    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith(NOTE));
  });

  it('Export as PDF and Print both invoke the printNote path', async () => {
    render(<ExportSection note={NOTE} />);
    fireEvent.click(screen.getByLabelText('Export as PDF'));
    await waitFor(() => expect(printNote).toHaveBeenCalledWith(NOTE));

    printNote.mockClear();
    fireEvent.click(screen.getByLabelText('Print'));
    await waitFor(() => expect(printNote).toHaveBeenCalledWith(NOTE));
  });

  it('surfaces a VISIBLE fallback when the print sheet never opens (ok:false)', async () => {
    printNote.mockResolvedValue({ ok: false });
    render(<ExportSection note={NOTE} />);
    fireEvent.click(screen.getByLabelText('Export as PDF'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t open the print sheet/i);
  });

  it('does NOT show the fallback on a successful print', async () => {
    render(<ExportSection note={NOTE} />);
    fireEvent.click(screen.getByLabelText('Print'));
    await waitFor(() => expect(printNote).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
