import type { Note } from '@deltos/shared';

/**
 * Cheap per-row preview derivation — pulls at most 2 text snippets from the first body blocks.
 * Does NOT do a full-doc serialization: scans block.content for known segment/code shapes only.
 * If the list-render measurably regresses load-feel, denormalize at save-time instead (YAGNI).
 */

function blockText(block: { content?: unknown }): string {
  const c = block.content;
  if (!c || typeof c !== 'object') return '';
  const o = c as Record<string, unknown>;
  if (Array.isArray(o['segments'])) {
    return (o['segments'] as Array<Record<string, unknown>>)
      .map((s) => (typeof s['text'] === 'string' ? s['text'] : ''))
      .join('');
  }
  if (typeof o['code'] === 'string') return o['code'];
  return '';
}

export interface NotePreview {
  /** Title to show in the list (note.title if set; else first body text; else "Untitled"). */
  displayTitle: string;
  /** One-line body preview. Uses second body snippet when title is absent (avoids duplicate line). */
  previewLine: string;
}

export function notePreview(note: Note): NotePreview {
  const title = (note.title ?? '').trim();
  const body = (note.body as Array<{ content?: unknown }> | undefined) ?? [];

  const snippets: string[] = [];
  for (const block of body) {
    if (snippets.length >= 2) break;
    const text = blockText(block).trim();
    if (text) snippets.push(text);
  }

  const [first = '', second = ''] = snippets;

  if (title) {
    return { displayTitle: title, previewLine: first };
  }
  return { displayTitle: first || 'Untitled', previewLine: second };
}

/**
 * Apple-Notes-style smart date: today → time; yesterday → "Yesterday";
 * this year → "Jun 12"; older → "Jun 12, 2024".
 */
export function formatSmartDate(iso: string): string {
  const now = new Date();
  const d = new Date(iso);

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysDiff = Math.round((todayMidnight.getTime() - dMidnight.getTime()) / 86_400_000);

  if (daysDiff === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (daysDiff === 1) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
