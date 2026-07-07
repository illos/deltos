/**
 * @vitest-environment jsdom
 *
 * exportNote unit tests (ROAD-0017). Exercises the two real emitters over a note body:
 *   - slugifyTitle: filesystem-safe download names;
 *   - exportMarkdown: builds a .md Blob (title + body markdown) and triggers a <a download> click;
 *   - printNote: renders into a (faked) iframe and invokes print() — resolving { ok:true } when the sheet
 *     opens (beforeprint fires) and { ok:false } on the iOS-PWA no-op (nothing fires within the grace window).
 * The attachment blob client is mocked (no Dexie/network); the iframe + object-URL are faked so the DOM-side
 * effects are asserted deterministically.
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

// A minimal appendable-free fake iframe: full stub so no real DOM/print is needed. srcdoc assignment drives
// onload on a microtask, mirroring the browser.
function fakeIframe(onPrint?: (listeners: Record<string, Array<() => void>>) => void) {
  const listeners: Record<string, Array<() => void>> = {};
  const win = {
    focus: vi.fn(),
    print: vi.fn(() => onPrint?.(listeners)),
    addEventListener: (ev: string, cb: () => void) => { (listeners[ev] ||= []).push(cb); },
  };
  const iframe = {
    setAttribute: vi.fn(),
    style: {} as Record<string, string>,
    contentWindow: win,
    remove: vi.fn(),
    onload: null as null | (() => void),
    _srcdoc: '',
    get srcdoc(): string { return this._srcdoc; },
    set srcdoc(v: string) { this._srcdoc = v; void Promise.resolve().then(() => this.onload?.()); },
  };
  return { iframe, win, listeners };
}

describe('printNote', () => {
  let appendSpy: ReturnType<typeof vi.fn>;
  afterEach(() => vi.restoreAllMocks());

  function installIframe(onPrint?: (l: Record<string, Array<() => void>>) => void) {
    const made = fakeIframe(onPrint);
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'iframe') return made.iframe as unknown as HTMLElement;
      return orig(tag);
    }) as typeof document.createElement);
    appendSpy = vi.fn((n: unknown) => n);
    vi.spyOn(document.body, 'appendChild').mockImplementation(appendSpy as unknown as typeof document.body.appendChild);
    return made;
  }

  it('renders into a hidden iframe and invokes focus + print', async () => {
    // Simulate the sheet opening: print() fires beforeprint synchronously (the desktop shape).
    const made = installIframe((l) => l['beforeprint']?.forEach((cb) => cb()));
    const result = await printNote(note());
    expect(made.win.focus).toHaveBeenCalledOnce();
    expect(made.win.print).toHaveBeenCalledOnce();
    expect(appendSpy).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('reports { ok:false } when the print sheet never opens (iOS-PWA no-op)', async () => {
    vi.useFakeTimers();
    const made = installIframe(); // print() is a no-op → no beforeprint ever fires
    const p = printNote(note());
    await vi.advanceTimersByTimeAsync(1000); // flush the onload microtask + the 900ms grace timeout
    await expect(p).resolves.toEqual({ ok: false });
    expect(made.iframe.remove).toHaveBeenCalled(); // the no-op iframe is torn down
    vi.useRealTimers();
  });
});
