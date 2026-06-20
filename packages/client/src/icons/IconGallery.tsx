/**
 * Visual reference + smoke surface for the icon set. Not wired into the app router (Lane 1 stays in
 * new files only); it exists so the look can be eyeballed in isolation and so the render test can
 * mount every icon from one list. `ICONS` is the single registry both consume.
 */
import type { ComponentType } from 'react';
import {
  Search, ComposeNew, Pencil, Notebook, Plus, Trash, SettingsSliders, Chevron, Ellipsis,
  VersionHistory, Undo, Redo, Checkbox, Checklist, Bold, Italic, Underline, Strike, Highlight,
  InlineCode, Link, BulletList, NumberedList, Quote, Divider, Image, SyncDot,
} from './index.js';
import type { IconProps } from './IconBase.js';

export interface IconEntry {
  name: string;
  Component: ComponentType<IconProps>;
}

/** Every icon in the set, in the design-packet order. */
export const ICONS: readonly IconEntry[] = [
  { name: 'search', Component: Search },
  { name: 'compose-new', Component: ComposeNew },
  { name: 'pencil', Component: Pencil },
  { name: 'notebook', Component: Notebook },
  { name: 'plus', Component: Plus },
  { name: 'trash', Component: Trash },
  { name: 'settings-sliders', Component: SettingsSliders },
  { name: 'chevron', Component: Chevron },
  { name: 'ellipsis', Component: Ellipsis },
  { name: 'version-history', Component: VersionHistory },
  { name: 'undo', Component: Undo },
  { name: 'redo', Component: Redo },
  { name: 'checkbox', Component: Checkbox },
  { name: 'checklist', Component: Checklist },
  { name: 'bold', Component: Bold },
  { name: 'italic', Component: Italic },
  { name: 'underline', Component: Underline },
  { name: 'strike', Component: Strike },
  { name: 'highlight', Component: Highlight },
  { name: 'inline-code', Component: InlineCode },
  { name: 'link', Component: Link },
  { name: 'bullet-list', Component: BulletList },
  { name: 'numbered-list', Component: NumberedList },
  { name: 'quote', Component: Quote },
  { name: 'divider', Component: Divider },
  { name: 'image', Component: Image },
  { name: 'sync-dot', Component: SyncDot },
];

/** A simple grid of every icon with its name — handy to drop behind a dev route later. */
export function IconGallery({ size = 24 }: { size?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
        gap: 16,
        padding: 24,
        color: 'var(--secondary, #6B7177)',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
      }}
    >
      {ICONS.map(({ name, Component }) => (
        <div
          key={name}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
        >
          <Component size={size} title={name} />
          <span>{name}</span>
        </div>
      ))}
    </div>
  );
}
