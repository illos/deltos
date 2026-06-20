/**
 * deltos icon set — inline-SVG, fine-line, theme-colored via `currentColor`.
 *
 * Hand-rolled (no icon font, no icon library) per the UI-refresh design packet. Path geometry is
 * lifted verbatim from the `Deltos Rich Text.dc.html` prototype wherever the prototype drew an
 * SVG; the four formatting marks the prototype rendered as styled letters (Bold/Italic/Underline/
 * Strike) are drawn here as matching fine-line glyphs. 24×24 grid, round caps/joins, stroke 1.4–1.7.
 *
 * Usage: `<Search />`, `<Trash size={24} />`, `<Notebook title="Field Notes" />`. Color follows the
 * surrounding `color` / theme token. Each icon is an independent named export (tree-shakeable — an
 * app pays only for the icons it imports).
 */
import { IconBase, type IconProps } from './IconBase.js';

export { IconBase } from './IconBase.js';
export type { IconProps } from './IconBase.js';

// — Navigation / shell —————————————————————————————————————————————————————

/** Magnifier. */
export function Search(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </IconBase>
  );
}

/** Compose a new note — pencil over a page. */
export function ComposeNew(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4 9.5-9.5z" />
    </IconBase>
  );
}

/** Plain pencil (edit / rename). */
export function Pencil(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M4 20l4-1L19.5 7.5a2 2 0 0 0-3-3L5 16l-1 4z" />
    </IconBase>
  );
}

/** Notebook spine. */
export function Notebook(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <line x1="9" y1="3.5" x2="9" y2="20.5" />
    </IconBase>
  );
}

/** Plus / add. */
export function Plus(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </IconBase>
  );
}

/** Trash can. */
export function Trash(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 13h8l1-13" />
    </IconBase>
  );
}

/** Settings — sliders/faders (two rails + knobs). */
export function SettingsSliders(props: IconProps) {
  return (
    <IconBase {...props}>
      <line x1="4" y1="8" x2="20" y2="8" />
      <circle cx="15" cy="8" r="2.4" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="9" cy="16" r="2.4" />
    </IconBase>
  );
}

/** Chevron — points LEFT (the prototype's back affordance). Rotate via CSS for other directions. */
export function Chevron(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M15 5l-7 7 7 7" />
    </IconBase>
  );
}

/** Horizontal ellipsis — overflow menu (filled dots). */
export function Ellipsis(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** Version history — clock face with a counter-clockwise reload arrow. */
export function VersionHistory(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </IconBase>
  );
}

/** Undo arrow. */
export function Undo(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M4 10h10a5 5 0 0 1 0 10h-4" />
      <path d="M8 6l-4 4 4 4" />
    </IconBase>
  );
}

/** Redo arrow. */
export function Redo(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M20 10H10a5 5 0 0 0 0 10h4" />
      <path d="M16 6l4 4-4 4" />
    </IconBase>
  );
}

// — Editor / rich text ————————————————————————————————————————————————————

/** Checkbox — rounded square with a check (composed; the prototype's bare check glyph + a box). */
export function Checkbox(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 12.4l2.8 2.8L16.5 9" />
    </IconBase>
  );
}

/** Checklist — checked rows. */
export function Checklist(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M3.5 6.5l1.6 1.6L8 5" />
      <line x1="11.5" y1="6.5" x2="20" y2="6.5" />
      <path d="M3.5 15.5l1.6 1.6L8 14" />
      <line x1="11.5" y1="15.5" x2="20" y2="15.5" />
    </IconBase>
  );
}

/** Bold — fine-line "B" (prototype used a styled letter). */
export function Bold(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </IconBase>
  );
}

/** Italic — fine-line slanted "I" (prototype used a styled letter). */
export function Italic(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <line x1="19" y1="5" x2="11" y2="5" />
      <line x1="13" y1="19" x2="5" y2="19" />
      <line x1="14" y1="5" x2="10" y2="19" />
    </IconBase>
  );
}

/** Underline — "U" with an underbar (prototype used a styled letter). */
export function Underline(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M6 4v7a6 6 0 0 0 12 0V4" />
      <line x1="5" y1="20" x2="19" y2="20" />
    </IconBase>
  );
}

/** Strikethrough — "S" cut by a center rule (prototype used a styled letter). */
export function Strike(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <path d="M16 8.2a3.4 3.4 0 0 0-3.4-3.2h-1.4a3 3 0 0 0-2.4 4.8" />
      <path d="M8 15.8a3.4 3.4 0 0 0 3.4 3.2h1.4a3 3 0 0 0 2.7-4.2" />
    </IconBase>
  );
}

/** Highlight — marker over an underline. */
export function Highlight(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M4 20h16" />
      <path d="M6 16l9-9 3 3-9 9H6v-3z" />
    </IconBase>
  );
}

/** Inline code — angle brackets. */
export function InlineCode(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </IconBase>
  );
}

/** Link — interlocked chain. */
export function Link(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M10 13a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1.2 1.2" />
      <path d="M14 11a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.2-1.2" />
    </IconBase>
  );
}

/** Bulleted list — filled dots + rules. */
export function BulletList(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <circle cx="4.5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
      <line x1="9" y1="6.5" x2="20" y2="6.5" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17.5" x2="20" y2="17.5" />
    </IconBase>
  );
}

/** Numbered list — 1/2/3 + rules (monospace numerals, per the prototype). */
export function NumberedList(props: IconProps) {
  const num = {
    fontSize: '7px',
    fontFamily: "'IBM Plex Mono', monospace",
    fill: 'currentColor',
    stroke: 'none',
  } as const;
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <line x1="9" y1="6.5" x2="20" y2="6.5" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17.5" x2="20" y2="17.5" />
      <text x="2" y="9" style={num}>1</text>
      <text x="2.6" y="14.4" style={num}>2</text>
      <text x="2.4" y="20" style={num}>3</text>
    </IconBase>
  );
}

/** Block quote — paired marks. */
export function Quote(props: IconProps) {
  return (
    <IconBase strokeWidth={1.6} {...props}>
      <path d="M7 7H4v4c0 2 1 3 3 3" />
      <path d="M16 7h-3v4c0 2 1 3 3 3" />
    </IconBase>
  );
}

/** Divider — horizontal rule. */
export function Divider(props: IconProps) {
  return (
    <IconBase strokeWidth={1.7} {...props}>
      <line x1="4" y1="12" x2="20" y2="12" />
    </IconBase>
  );
}

/** Image / attachment. */
export function Image(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M5 18l5-5 4 4 2-2 4 4" />
    </IconBase>
  );
}

/**
 * Sync status dot — a solid disc. ALWAYS render in the green `--sync` token, never the accent
 * (`style={{ color: 'var(--sync)' }}`); "saved" must never read as "alert" (design invariant).
 */
export function SyncDot(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
    </IconBase>
  );
}
