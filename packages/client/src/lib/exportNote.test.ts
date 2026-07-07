/**
 * @vitest-environment jsdom
 *
 * exportNote unit tests (ROAD-0017). Exercises the two real emitters over a note body:
 *   - slugifyTitle: filesystem-safe download names;
 *   - exportMarkdown: builds a .md Blob (title + body markdown) and triggers a <a download> click;
 *   - printNote: injects a print-only `.dltos-print-root` container on the MAIN document (NOT an iframe — iOS
 *     ignores iframe.print()), swaps document.title to the note title so the Save-as-PDF filename is right,
 *     calls window.print(), and tears the container down + restores the title once the print interaction ends
 *     (afterprint / focus / safety timeout). Resolves { ok:true } when the sheet opens (beforeprint fires) and
 *     { ok:false } on the iOS-PWA no-op (nothing fires within the grace window) or when print() throws.
 * The attachment blob client is mocked (no Dexie/network); window.print is spied so no real OS sheet opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Note } from '@deltos/shared';

vi.mock('../plugins/attachment/blobClient.js', () => ({ loadBlobUrl: vi.fn(async () => 'blob:att') }));

import { slugifyTitle, exportMarkdown, printNote } from './exportNote.js';

const note = (over: Partial<Note> = {}): Note =>
  ({
    id: 'n1',
    notebookId: null,
    title: 'My Note',
    properties: {},
    body: [{ id: 'p', type: 'paragraph', content: { segments: [{ text: 'hello body' }] } }],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 1,
    ...over,
  }) as unknown as Note;

describe('slugifyTitle', () => {
  it('lowercases and hyphenates', () => { expect(slugifyTitle('My Great Note')).toBe('my-great-note'); });
  it('strips punctuation and collapses runs', () => { expect(slugifyTitle('Q3 — Report!! (final)')).toBe('q3-report-final'); });
  it('trims leading/trailing hyphens', () => { expect(slugifyTitle('  --hi--  ')).toBe('hi'); });
  it('falls back to untitled when empty', () => { expect(slugifyTitle('   ')).toBe('untitled'); expect(slugifyTitle('!!!')).toBe('untitled'); });
});

describe('exportMarkdown', () => {
  let captured: Blob | null;
  let anchor: HTMLAnchorElement | null;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captured = null;
    anchor = null;
    clickSpy = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((b: Blob) => { captured = b; return 'blob:md'; });
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === 'a') { anchor = el as HTMLAnchorElement; el.click = clickSpy; }
      return el;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('names the file from the title and clicks a download anchor', async () => {
    await exportMarkdown(note({ title: 'My Note' }));
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(anchor!.download).toBe('my-note.md');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:md');
  });

  it('writes the title as a leading # heading followed by the body markdown', async () => {
    await exportMarkdown(note({ title: 'My Note' }));
    const text = await captured!.text();
    expect(text).toBe('# My Note\n\nhello body');
    expect(captured!.type).toContain('text/markdown');
  });
});

// Flush the async attachment resolver + the synchronous container-injection / print() body on real timers.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('printNote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Belt-and-suspenders: drop any container/style a test left behind so cases don't leak into each other.
    document.querySelectorAll('.dltos-print-root, style[data-dltos-print]').forEach((n) => n.remove());
    document.title = '';
  });

  it('injects a print-only container on the MAIN document, swaps document.title, and reports ok on beforeprint', async () => {
    document.title = 'deltos';
    let titleAtPrint = '';
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => { titleAtPrint = document.title; });

    const p = printNote(note({ title: 'My Note' }));
    await tick(); // flush resolver + injection + print()

    // (a) a .dltos-print-root container carrying the note's rendered content is in document.body.
    const container = document.querySelector('.dltos-print-root');
    expect(container).not.toBeNull();
    expect(container!.parentElement).toBe(document.body);
    expect(container!.querySelector('h1.dltos-export-title')!.textContent).toBe('My Note');
    expect(container!.textContent).toContain('hello body');
    expect(document.querySelector('style[data-dltos-print]')).not.toBeNull();

    // (b) document.title is the NOTE title at the moment print() is called.
    expect(printSpy).toHaveBeenCalledOnce();
    expect(titleAtPrint).toBe('My Note');

    // The sheet opened → beforeprint → ok:true.
    window.dispatchEvent(new Event('beforeprint'));
    await expect(p).resolves.toEqual({ ok: true });

    // (c) once the interaction ends (afterprint), the container + style are removed and the title restored.
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('.dltos-print-root')).toBeNull();
    expect(document.querySelector('style[data-dltos-print]')).toBeNull();
    expect(document.title).toBe('deltos');
  });

  it('cleans up via the focus fallback when afterprint never fires (iOS)', async () => {
    document.title = 'deltos';
    vi.spyOn(window, 'print').mockImplementation(() => {});

    const p = printNote(note({ title: 'My Note' }));
    await tick();
    window.dispatchEvent(new Event('beforeprint'));
    await expect(p).resolves.toEqual({ ok: true });

    // No afterprint on iOS — the next window focus (user returning) tears it down + restores the title.
    expect(document.querySelector('.dltos-print-root')).not.toBeNull();
    window.dispatchEvent(new Event('focus'));
    expect(document.querySelector('.dltos-print-root')).toBeNull();
    expect(document.title).toBe('deltos');
  });

  it('reports { ok:false } when the print sheet never opens (iOS-PWA no-op), then the safety timeout cleans up', async () => {
    vi.useFakeTimers();
    document.title = 'deltos';
    vi.spyOn(window, 'print').mockImplementation(() => {}); // no beforeprint ever fires

    const p = printNote(note({ title: 'My Note' }));
    await vi.advanceTimersByTimeAsync(900); // flush resolver microtasks + the 900ms grace timeout
    await expect(p).resolves.toEqual({ ok: false });

    // The container is still up (nothing opened to tear it down yet); the 10s safety timeout removes it.
    expect(document.querySelector('.dltos-print-root')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(document.querySelector('.dltos-print-root')).toBeNull();
    expect(document.title).toBe('deltos');
    vi.useRealTimers();
  });

  it('reports { ok:false } and tears down immediately when print() throws', async () => {
    document.title = 'deltos';
    vi.spyOn(window, 'print').mockImplementation(() => { throw new Error('print blocked'); });

    const p = printNote(note({ title: 'My Note' }));
    await expect(p).resolves.toEqual({ ok: false });
    // A throw means nothing opened → immediate teardown + title restore.
    expect(document.querySelector('.dltos-print-root')).toBeNull();
    expect(document.title).toBe('deltos');
  });
});
