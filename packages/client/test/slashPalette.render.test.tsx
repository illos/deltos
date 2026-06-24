/**
 * A5 (#127) — slash palette tests.
 * Unit tests for buildPaletteItems / matchesQuery + PM plugin trigger/navigation behavior.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deltoSchema } from '../src/editor/schema.js';
import {
  buildPaletteItems,
  matchesQuery,
  SlashPalette,
  type PaletteItem,
} from '../src/editor/slashPalette/index.js';
import { createSlashPalettePlugin } from '../src/editor/slashPalette/slashPalettePlugin.js';
import type { PaletteEvent } from '../src/editor/slashPalette/slashPalettePlugin.js';
import { EDITOR_TOOLS } from '../src/editor/editorTools.js';
import type { PluginManifest } from '../src/plugins/runtime/manifest.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let view: EditorView | null = null;
afterEach(() => {
  cleanup(); // unmount React components first (clears portals cleanly)
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function mountEditor(text: string, plugins: Plugin[]): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const para = deltoSchema.nodes['paragraph']!.create({ id: null }, text ? deltoSchema.text(text) : []);
  const doc = deltoSchema.nodes['doc']!.create(null, [
    deltoSchema.nodes['title']!.create({ id: null }),
    para,
  ]);
  let state = EditorState.create({ doc, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, { state });
  return view;
}

const typeChar = (v: EditorView, ch: string) => {
  const { from } = v.state.selection;
  // Call the handleTextInput props (sets pendingSliceStart in our plugin), then dispatch the
  // character insertion so the view update() cycle fires and pendingSliceStart is consumed.
  v.someProp('handleTextInput', (f) => f(v, from, from, ch));
  v.dispatch(v.state.tr.insertText(ch, from));
};

const pressKey = (v: EditorView, key: string) => {
  const evt = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  v.someProp('handleKeyDown', (f) => f(v, evt));
};

// ── buildPaletteItems ─────────────────────────────────────────────────────────

describe('buildPaletteItems', () => {
  it('includes desktop tools and excludes mobile-only tools', () => {
    const items = buildPaletteItems(EDITOR_TOOLS, []);
    const ids = items.filter((i) => i.kind === 'tool').map((i) => (i as PaletteItem & { kind: 'tool' }).tool.id);
    // mobile-only 'link' (insert/mobile) is excluded; desktop 'link' (format/desktop) is included
    expect(ids).toContain('link');
    // each id appears exactly once (dedup)
    const seen = new Set(ids);
    expect(ids.length).toBe(seen.size);
  });

  it('orders: insert first, then style, lists, format', () => {
    const items = buildPaletteItems(EDITOR_TOOLS, []);
    const groups = items
      .filter((i): i is PaletteItem & { kind: 'tool' } => i.kind === 'tool')
      .map((i) => i.tool.group);
    const firstFormat = groups.indexOf('format');
    const lastInsert = groups.lastIndexOf('insert');
    const lastStyle = groups.lastIndexOf('style');
    const lastLists = groups.lastIndexOf('lists');
    expect(lastInsert).toBeLessThan(firstFormat);
    expect(lastStyle).toBeLessThan(firstFormat);
    expect(lastLists).toBeLessThan(firstFormat);
  });

  it('includes plugin blocks from manifests with palette entries', () => {
    const manifests: PluginManifest[] = [
      { id: 'my-block', name: 'My Block', palette: { label: 'My Block', keywords: ['block'] }, load: () => ({}) },
      { id: 'no-palette', name: 'No Palette', load: () => ({}) },
    ];
    const items = buildPaletteItems([], manifests);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('block');
    expect((items[0] as PaletteItem & { kind: 'block' }).label).toBe('My Block');
  });
});

// ── matchesQuery ──────────────────────────────────────────────────────────────

describe('matchesQuery', () => {
  const toolItem: PaletteItem = { kind: 'tool', tool: EDITOR_TOOLS.find((t) => t.label === 'Heading')! };

  it('empty / whitespace-only query matches everything', () => {
    expect(matchesQuery(toolItem, '')).toBe(true);
    expect(matchesQuery(toolItem, '  ')).toBe(true);
  });

  it('substring match on label (case-insensitive)', () => {
    expect(matchesQuery(toolItem, 'head')).toBe(true);
    expect(matchesQuery(toolItem, 'HEAD')).toBe(true);
    expect(matchesQuery(toolItem, 'xyz')).toBe(false);
  });

  it('keyword match on block items', () => {
    const blockItem: PaletteItem = {
      kind: 'block',
      manifest: { id: 'x', name: 'X', palette: { label: 'X Widget', keywords: ['widget', 'embed'] }, load: () => ({}) },
      label: 'X Widget',
      keywords: ['widget', 'embed'],
    };
    expect(matchesQuery(blockItem, 'embed')).toBe(true);
    expect(matchesQuery(blockItem, 'WIDGET')).toBe(true);
    expect(matchesQuery(blockItem, 'nope')).toBe(false);
  });

  it('leading whitespace in query is trimmed (typing / then space then query)', () => {
    expect(matchesQuery(toolItem, ' head')).toBe(true);
  });
});

// ── PM plugin — trigger ───────────────────────────────────────────────────────

describe('createSlashPalettePlugin — trigger', () => {
  it('fires open event when / is typed at block start', () => {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: true });
    const v = mountEditor('', [plugin]);
    typeChar(v, '/');
    expect(events.some((e) => e.type === 'open')).toBe(true);
  });

  it('does NOT fire when / is typed mid-word', () => {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: true });
    const v = mountEditor('hello', [plugin]);
    typeChar(v, '/');
    expect(events.filter((e) => e.type === 'open')).toHaveLength(0);
  });

  it('fires after whitespace (e.g. "hello " + /)', () => {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: true });
    const v = mountEditor('hello ', [plugin]);
    typeChar(v, '/');
    expect(events.some((e) => e.type === 'open')).toBe(true);
  });

  it('does NOT fire when enabledRef.current = false', () => {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: false });
    const v = mountEditor('', [plugin]);
    typeChar(v, '/');
    expect(events).toHaveLength(0);
  });
});

// ── PM plugin — navigation ────────────────────────────────────────────────────

describe('createSlashPalettePlugin — keyboard navigation', () => {
  function setupOpenPalette() {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: true });
    const v = mountEditor('', [plugin]);
    typeChar(v, '/');
    return { v, events };
  }

  it('ArrowDown dispatches nav:down and intercepts the key', () => {
    const { v, events } = setupOpenPalette();
    pressKey(v, 'ArrowDown');
    const navEvents = events.filter((e) => e.type === 'nav') as Extract<PaletteEvent, { type: 'nav' }>[];
    expect(navEvents.some((e) => e.direction === 'down')).toBe(true);
  });

  it('ArrowUp dispatches nav:up', () => {
    const { v, events } = setupOpenPalette();
    pressKey(v, 'ArrowUp');
    const navEvents = events.filter((e) => e.type === 'nav') as Extract<PaletteEvent, { type: 'nav' }>[];
    expect(navEvents.some((e) => e.direction === 'up')).toBe(true);
  });

  it('Escape dispatches close', () => {
    const { v, events } = setupOpenPalette();
    pressKey(v, 'Escape');
    expect(events.some((e) => e.type === 'close')).toBe(true);
  });

  it('Enter dispatches enter with sliceStart', () => {
    const { v, events } = setupOpenPalette();
    pressKey(v, 'Enter');
    const enterEvents = events.filter((e) => e.type === 'enter');
    expect(enterEvents).toHaveLength(1);
    expect((enterEvents[0] as Extract<PaletteEvent, { type: 'enter' }>).sliceStart).toBeGreaterThanOrEqual(0);
  });

  it('arrow keys do nothing when palette is closed', () => {
    const events: PaletteEvent[] = [];
    const plugin = createSlashPalettePlugin((e) => events.push(e), { current: true });
    const v = mountEditor('', [plugin]);
    pressKey(v, 'ArrowDown');
    expect(events.filter((e) => e.type === 'nav')).toHaveLength(0);
  });

  it('Escape after close does not dispatch again', () => {
    const { v, events } = setupOpenPalette();
    pressKey(v, 'Escape');
    const countAfterEsc = events.length;
    pressKey(v, 'Escape');
    expect(events.length).toBe(countAfterEsc);
  });
});

// ── SlashPalette component ────────────────────────────────────────────────────

describe('SlashPalette component', () => {
  const anchor = { left: 100, bottom: 200 };
  const tools = EDITOR_TOOLS;
  const manifests: PluginManifest[] = [];

  it('renders nothing when anchor is null', () => {
    const { container } = render(
      <SlashPalette
        anchor={null}
        query=""
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders item labels when open with empty query', () => {
    render(
      <SlashPalette
        anchor={anchor}
        query=""
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Should show at least one well-known tool label
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    expect(screen.getByText('Heading')).toBeDefined();
  });

  it('filters items by query', () => {
    render(
      <SlashPalette
        anchor={anchor}
        query="bullet"
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Only 'Bullet list' should match
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Bullet list');
  });

  it('calls onSelect when an item is pointer-downed', () => {
    const onSelect = vi.fn();
    render(
      <SlashPalette
        anchor={anchor}
        query=""
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const options = screen.getAllByRole('option');
    options[0]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('marks the clamped item as aria-selected', () => {
    render(
      <SlashPalette
        anchor={anchor}
        query=""
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const selected = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.classList.contains('slash-palette__item--selected')).toBe(true);
  });

  it('renders nothing when query matches nothing', () => {
    const { container } = render(
      <SlashPalette
        anchor={anchor}
        query="xyzxyzxyz-nomatch"
        selectedIndex={0}
        tools={tools}
        manifests={manifests}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
