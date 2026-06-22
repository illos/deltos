/**
 * Deploy 3 — slice G: editor element styles are theme-var driven (spec §6). Reads styles.css and
 * asserts the .editor__pm element rules read tokens (no hardcoded hex), the new marks (u/s/mark)
 * exist, the highlight uses the accent-24% invariant, the editable root is anchored to var(--note)
 * (>=16px → iOS no-zoom), and the checklist box matches the packet (19px + accent fill).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8');
/** Slice the .editor__pm element-style region from styles.css for scoped assertions. */
const editorBlock = css.slice(css.indexOf('ProseMirror element styles'), css.indexOf('Plugin island placeholder'));

describe('editor element styles — theme-var driven (spec §6)', () => {
  it('the editable root anchors font-size to var(--note) (iOS no-zoom) + voice ff/colour', () => {
    expect(editorBlock).toMatch(/\.editor__pm \.ProseMirror\s*\{[^}]*font-size:\s*var\(--note\)/);
    expect(editorBlock).toMatch(/\.editor__pm \.ProseMirror\s*\{[^}]*font-family:\s*var\(--ff\)/);
  });

  it('headings/quote/lists read the type-scale + colour tokens', () => {
    expect(editorBlock).toMatch(/h1\s*\{[^}]*font-size:\s*var\(--h1\)/);
    expect(editorBlock).toMatch(/h2\s*\{[^}]*font-size:\s*var\(--h2\)/);
    expect(editorBlock).toMatch(/blockquote\s*\{[^}]*var\(--quote\)/);
    expect(editorBlock).toMatch(/blockquote\s*\{[^}]*border-left:\s*2px solid var\(--accent\)/);
  });

  it('pre + inline code use the mono var + --sel surface (no hardcoded hex)', () => {
    expect(editorBlock).toMatch(/pre\s*\{[^}]*font-family:\s*var\(--mono\)/);
    expect(editorBlock).toMatch(/pre\s*\{[^}]*background:\s*var\(--sel\)/);
    expect(editorBlock).toMatch(/\.ProseMirror code\s*\{[^}]*background:\s*var\(--sel\)/);
    // The pre/code surfaces no longer reference the old ad-hoc charcoal hex.
    expect(editorBlock).not.toContain('#1a1d2a');
  });

  it('the three new marks render (u underline, s line-through, mark = accent 24%)', () => {
    expect(editorBlock).toMatch(/\.ProseMirror u\s*\{[^}]*underline/);
    expect(editorBlock).toMatch(/\.ProseMirror s\s*\{[^}]*line-through/);
    expect(editorBlock).toMatch(/\.ProseMirror mark\s*\{[^}]*color-mix\(in srgb, var\(--accent\) 24%/);
  });

  it('the link uses --accent and hr uses --border', () => {
    expect(editorBlock).toMatch(/\.ProseMirror a\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(editorBlock).toMatch(/\.ProseMirror hr\s*\{[^}]*border-top:\s*1px solid var\(--border\)/);
  });

  it('checklist box: 19px, --faint border, accent fill when checked', () => {
    expect(editorBlock).toMatch(/\.todo__check\s*\{[^}]*width:\s*19px/);
    expect(editorBlock).toMatch(/\.todo__check\s*\{[^}]*border:\s*1\.6px solid var\(--faint\)/);
    expect(editorBlock).toMatch(/\[data-checked="true"\] \.todo__check\s*\{[^}]*background:\s*var\(--accent\)/);
  });
});
