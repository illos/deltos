import type { ComponentType } from 'react';
import type { Command } from 'prosemirror-state';
import type { IconProps } from '../icons/index.js';
import { Highlight, InlineCode, Link, BulletList, NumberedList, Checklist, Quote, Divider, Plus } from '../icons/index.js';
import type { DeltoSchema } from './schema.js';
import type { EditorActiveState } from './editorState.js';
import { commandFor } from './commands.js';
import { isToolActive } from './editorState.js';

/**
 * TOOL-DESCRIPTOR REGISTRY — the single data-driven source for both editor surfaces. The desktop
 * EditorToolbar and the mobile MobileEditorBar both RENDER from this array (filtered by surface,
 * grouped, ordered); there is no second hardcoded button list. Adding a tool later = appending a
 * descriptor — zero core toolbar changes. The runtime plugin-REGISTRATION api is intentionally out of
 * scope (a future attachment plugin will pull it into existence against a real need); this is only the
 * shape. Built-in tools delegate command/active to the slice-B by-id seams (commandFor / isToolActive)
 * so logic lives in exactly one place; a plugin tool would instead supply its own command/isActive.
 */

export type ToolGroup = 'style' | 'format' | 'lists' | 'insert';
export type ToolSurface = 'both' | 'desktop' | 'mobile';
export type ToolRender = 'text' | 'icon';

export interface ToolDescriptor {
  /** data-cmd id (bold, h2, ul, quote, …). May repeat across surface-scoped descriptors (e.g. link). */
  id: string;
  group: ToolGroup;
  surface: ToolSurface;
  render: ToolRender;
  /** Accessible name (aria-label) always; also the visible text for render:'text' tools w/o a glyph. */
  label: string;
  /** Styled single-glyph visible text for the B/I/U/S marks (locked decision 3); falls back to label. */
  glyph?: string;
  /** Icon component for render:'icon' tools. */
  icon?: ComponentType<IconProps>;
  /** Command builder, by reference (slice B). Built-ins route through commandFor(id). */
  command: (schema: DeltoSchema) => Command;
  /** Active predicate reading the slice-B deriveActiveState snapshot. Built-ins route through isToolActive(id). */
  isActive: (active: EditorActiveState) => boolean;
  isEnabled?: (active: EditorActiveState) => boolean;
  /** Sort order within the group. */
  order: number;
}

/** Group order is fixed data (not deeply hardcoded): style → format → lists → insert. */
export const TOOL_GROUPS: readonly ToolGroup[] = ['style', 'format', 'lists', 'insert'];

// Built-in descriptors delegate to the by-id seams — keeps command/active logic single-sourced.
const cmd = (id: string) => (schema: DeltoSchema): Command => commandFor(schema, id);
const act = (id: string) => (a: EditorActiveState): boolean => isToolActive(a, id);

export const EDITOR_TOOLS: readonly ToolDescriptor[] = [
  // ── Style: block types as text labels (no glyph — they show their words) ────────────────────────
  { id: 'h1', group: 'style', surface: 'both', render: 'text', label: 'Title',   order: 1, command: cmd('h1'), isActive: act('h1') },
  { id: 'h2', group: 'style', surface: 'both', render: 'text', label: 'Heading', order: 2, command: cmd('h2'), isActive: act('h2') },
  { id: 'h3', group: 'style', surface: 'both', render: 'text', label: 'Subhead', order: 3, command: cmd('h3'), isActive: act('h3') },
  { id: 'p',  group: 'style', surface: 'both', render: 'text', label: 'Body',    order: 4, command: cmd('p'),  isActive: act('p')  },
  { id: 'pre', group: 'style', surface: 'both', render: 'text', label: 'Mono',   order: 5, command: cmd('pre'), isActive: act('pre') },

  // ── Format: B/I/U/S as styled glyphs, then highlight/code/(desktop)link as icons ────────────────
  { id: 'bold',      group: 'format', surface: 'both', render: 'text', label: 'Bold',          glyph: 'B', order: 1, command: cmd('bold'),      isActive: act('bold') },
  { id: 'italic',    group: 'format', surface: 'both', render: 'text', label: 'Italic',        glyph: 'I', order: 2, command: cmd('italic'),    isActive: act('italic') },
  { id: 'underline', group: 'format', surface: 'both', render: 'text', label: 'Underline',     glyph: 'U', order: 3, command: cmd('underline'), isActive: act('underline') },
  { id: 'strike',    group: 'format', surface: 'both', render: 'text', label: 'Strikethrough', glyph: 'S', order: 4, command: cmd('strike'),    isActive: act('strike') },
  { id: 'mark', group: 'format', surface: 'both', render: 'icon', label: 'Highlight', icon: Highlight,  order: 5, command: cmd('mark'), isActive: act('mark') },
  { id: 'code', group: 'format', surface: 'both', render: 'icon', label: 'Code',      icon: InlineCode, order: 6, command: cmd('code'), isActive: act('code') },
  // Link lives in the inline group on DESKTOP (mock §2) but the insert tray on MOBILE (mock §3) —
  // modeled as two surface-scoped descriptors sharing one command/active by reference. This shows a
  // tool's GROUP can differ per surface; the two-descriptor pattern handles it cleanly today. FUTURE
  // (plugin-registration API, not now): the descriptor type may grow a per-surface placement field so
  // a plugin can express this in a single entry — until then, surface-scoped descriptors are the seam.
  { id: 'link', group: 'format', surface: 'desktop', render: 'icon', label: 'Link', icon: Link, order: 7, command: cmd('link'), isActive: act('link') },

  // ── Lists ───────────────────────────────────────────────────────────────────────────────────────
  { id: 'ul',    group: 'lists', surface: 'both', render: 'icon', label: 'Bullet list',  icon: BulletList,   order: 1, command: cmd('ul'),    isActive: act('ul') },
  { id: 'ol',    group: 'lists', surface: 'both', render: 'icon', label: 'Numbered list', icon: NumberedList, order: 2, command: cmd('ol'),    isActive: act('ol') },
  { id: 'check', group: 'lists', surface: 'both', render: 'icon', label: 'Checklist',    icon: Checklist,    order: 3, command: cmd('check'), isActive: act('check') },

  // ── Insert: (mobile) link, then quote + divider (both surfaces). Image omitted — deferred to a
  //    future attachment plugin (R2 blob storage / content-addressing), intentionally not a stub. ──
  { id: 'link',    group: 'insert', surface: 'mobile', render: 'icon', label: 'Link',    icon: Link,    order: 1, command: cmd('link'),    isActive: act('link') },
  { id: 'quote',   group: 'insert', surface: 'both',   render: 'icon', label: 'Quote',   icon: Quote,   order: 2, command: cmd('quote'),   isActive: act('quote') },
  { id: 'divider', group: 'insert', surface: 'both',   render: 'icon', label: 'Divider', icon: Divider, order: 3, command: cmd('divider'), isActive: () => false },
];

/** Tools visible on a surface, in a group, sorted by order. */
export function toolsFor(surface: 'desktop' | 'mobile', group: ToolGroup): ToolDescriptor[] {
  return EDITOR_TOOLS
    .filter((t) => t.group === group && (t.surface === 'both' || t.surface === surface))
    .sort((a, b) => a.order - b.order);
}

/**
 * Group-level toggle metadata — the label + visible affordance for each group's selector control
 * (Aa=style, B=format, ☰=lists, +=insert). Shared by every surface that renders a group selector:
 * the mobile MobileEditorBar (native-keyboard mode) and the Deck editor loadout (custom-keyboard mode),
 * so the group affordances stay identical across both.
 */
export interface GroupToggle {
  group: ToolGroup;
  label: string;
  glyph?: string;
  icon?: ComponentType<IconProps>;
}
export const GROUP_TOGGLES: readonly GroupToggle[] = [
  { group: 'style',  label: 'Style',  glyph: 'Aa' },
  { group: 'format', label: 'Format', glyph: 'B' },
  { group: 'lists',  label: 'Lists',  icon: BulletList },
  { group: 'insert', label: 'Insert', icon: Plus },
];
