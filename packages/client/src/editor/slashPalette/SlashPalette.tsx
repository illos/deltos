/**
 * Slash palette component + item-building utilities (docs/specs/plugin-support.md §10.1, A5).
 * Floating insert/command popup anchored at the `/` caret position. Desktop-primary.
 */
import { useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PluginManifest } from '../../plugins/runtime/manifest.js';
import type { ToolDescriptor } from '../editorTools.js';

export type PaletteItemTool = { readonly kind: 'tool'; readonly tool: ToolDescriptor };
export type PaletteItemBlock = {
  readonly kind: 'block';
  readonly manifest: PluginManifest;
  readonly label: string;
  readonly keywords: readonly string[];
};
export type PaletteItem = PaletteItemTool | PaletteItemBlock;

// insert → style → lists → format: most-structural first, inline-marks last.
const GROUP_ORDER = ['insert', 'style', 'lists', 'format'] as const;

/** Build the full (unfiltered) palette item list: insert/style/lists/format tools then plugin blocks. */
export function buildPaletteItems(
  tools: readonly ToolDescriptor[],
  manifests: readonly PluginManifest[],
): PaletteItem[] {
  const seen = new Set<string>();
  const toolItems = [...tools]
    .filter((t) => t.surface !== 'mobile')
    .sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.group as (typeof GROUP_ORDER)[number]);
      const gb = GROUP_ORDER.indexOf(b.group as (typeof GROUP_ORDER)[number]);
      const gi = (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
      return gi !== 0 ? gi : a.order - b.order;
    })
    .reduce<PaletteItemTool[]>((acc, tool) => {
      if (!seen.has(tool.id)) {
        seen.add(tool.id);
        acc.push({ kind: 'tool', tool });
      }
      return acc;
    }, []);

  const blockItems: PaletteItemBlock[] = manifests
    .filter((m): m is PluginManifest & { palette: NonNullable<PluginManifest['palette']> } => m.palette != null)
    .map((m) => ({
      kind: 'block' as const,
      manifest: m,
      label: m.palette.label,
      keywords: m.palette.keywords ?? [],
    }));

  return [...toolItems, ...blockItems];
}

/** Case-insensitive substring match on label + keywords. Whitespace-only query matches all. */
export function matchesQuery(item: PaletteItem, q: string): boolean {
  const lq = q.trim().toLowerCase();
  if (!lq) return true;
  const label = item.kind === 'tool' ? item.tool.label : item.label;
  if (label.toLowerCase().includes(lq)) return true;
  if (item.kind === 'block') return item.keywords.some((k) => k.toLowerCase().includes(lq));
  return false;
}

interface SlashPaletteProps {
  anchor: { left: number; bottom: number } | null;
  query: string;
  selectedIndex: number;
  tools: readonly ToolDescriptor[];
  manifests: readonly PluginManifest[];
  onSelect: (item: PaletteItem) => void;
  onClose: () => void;
}

export function SlashPalette({
  anchor,
  query,
  selectedIndex,
  tools,
  manifests,
  onSelect,
  onClose,
}: SlashPaletteProps) {
  const allItems = useMemo(() => buildPaletteItems(tools, manifests), [tools, manifests]);
  const items = useMemo(() => allItems.filter((it) => matchesQuery(it, query)), [allItems, query]);
  const clamped = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : -1;

  // Outside-click dismissal: deferred so the click that opened the palette doesn't immediately close it.
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.slash-palette')) onClose();
    };
    const id = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [anchor, onClose]);

  if (!anchor || items.length === 0) return null;

  const vh = typeof window !== 'undefined' ? window.innerHeight : 600;
  const spaceBelow = vh - anchor.bottom;
  const style: React.CSSProperties =
    spaceBelow < 200
      ? { left: anchor.left, bottom: vh - anchor.bottom + 4 }
      : { left: anchor.left, top: anchor.bottom + 4 };

  return createPortal(
    <div className="slash-palette" style={style} role="listbox" aria-label="Insert">
      {items.map((item, i) => {
        const id = item.kind === 'tool' ? item.tool.id : item.manifest.id;
        const label = item.kind === 'tool' ? item.tool.label : item.label;
        const Icon = item.kind === 'tool' ? item.tool.icon : undefined;
        return (
          <button
            key={`${item.kind}-${id}`}
            type="button"
            role="option"
            aria-selected={i === clamped}
            className={`slash-palette__item${i === clamped ? ' slash-palette__item--selected' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
          >
            {Icon && (
              <span className="slash-palette__icon" aria-hidden="true">
                <Icon />
              </span>
            )}
            <span className="slash-palette__label">{label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
