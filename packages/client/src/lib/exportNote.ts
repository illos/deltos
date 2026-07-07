import {
  spineToMarkdown,
  spineToHtml,
  escapeHtmlText,
  ATTACHMENT_PLUGIN_TYPE,
  type Note,
  type Block,
  type AttachmentContent,
} from '@deltos/shared';
import { loadBlobUrl } from '../plugins/attachment/blobClient.js';

/**
 * exportNote — the client side of ROAD-0017 export controls. Two emitters over the SAME `Block[]` note body
 * (CONV-0004): a Markdown `.md` download (via the shared `spineToMarkdown`) and a Print / Save-as-PDF path
 * (via the shared `spineToHtml` rendered into a hidden iframe → the OS print/share sheet). Everything here is
 * reached ONLY from the lazy ExportPanel chunk, so it never enters the mobile first-load bundle.
 *
 * Attachment URLs (a note's own image/file blobs) resolve to session blob: object-URLs through the attachment
 * plugin's `loadBlobUrl` — best-effort: a blob that can't load (offline + uncached) degrades to its bare
 * filename in Markdown / an inert filename in the print render, never a broken link or a crash.
 */

/** Walk the block tree (children included) collecting attachment blocks' content payloads. */
function collectAttachments(blocks: Block[]): AttachmentContent[] {
  const out: AttachmentContent[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === ATTACHMENT_PLUGIN_TYPE && b.content && typeof b.content === 'object') {
        const c = b.content as Record<string, unknown>;
        if (typeof c['hash'] === 'string' && typeof c['name'] === 'string') {
          out.push({
            hash: c['hash'],
            name: c['name'],
            mime: typeof c['mime'] === 'string' ? c['mime'] : 'application/octet-stream',
            size: typeof c['size'] === 'number' ? c['size'] : 0,
          });
        }
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * Pre-resolve every attachment in the body to a blob: object-URL and return a SYNCHRONOUS resolver keyed by
 * hash — the shape both `spineToMarkdown` and `spineToHtml` accept. Resolution is async + best-effort (a blob
 * that won't load is simply absent from the map → the serializer emits the inert filename form).
 */
async function buildAttachmentResolver(blocks: Block[]): Promise<(att: AttachmentContent) => string | null> {
  const atts = collectAttachments(blocks);
  const urls = new Map<string, string>();
  await Promise.all(
    atts.map(async (att) => {
      try {
        urls.set(att.hash, await loadBlobUrl(att.hash, att.mime));
      } catch {
        /* offline + uncached — degrade to the filename form */
      }
    }),
  );
  return (att: AttachmentContent) => urls.get(att.hash) ?? null;
}

/** A filesystem-safe slug for the download filename; falls back to `untitled`. */
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

/**
 * Export the note body as a Markdown `.md` file download. Prepends the title as a leading `# {title}`. Uses a
 * Blob + object-URL + a programmatic `<a download>` click, revoking the URL immediately after (the download
 * has already been handed to the browser by the time click() returns).
 */
export async function exportMarkdown(note: Note): Promise<void> {
  const attachmentUrl = await buildAttachmentResolver(note.body);
  const md = spineToMarkdown(note.body, { title: note.title, attachmentUrl });
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyTitle(note.title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Wrap the rendered body HTML in a standalone print document with a readable print stylesheet. */
function buildPrintDocument(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtmlText(title.trim() || 'Untitled');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; }
    body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           padding: 2rem; max-width: 44rem; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
    h1 { font-size: 1.9rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; }
    p, ul, ol, blockquote, pre { margin: 0.6em 0; }
    ul, ol { padding-left: 1.5rem; }
    blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #444; }
    pre { background: #f5f5f5; padding: 0.8rem 1rem; border-radius: 6px; overflow-x: auto; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    pre code { font-size: 0.85rem; }
    hr { border: 0; border-top: 1px solid #ddd; margin: 1.5em 0; }
    img { max-width: 100%; height: auto; }
    mark { background: #fff2a8; }
    a { color: #0645ad; text-decoration: underline; }
    .dltos-todo { list-style: none; }
    .dltos-todo input { margin-right: 0.4em; }
    h1.dltos-export-title { margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    @page { margin: 18mm; }
    @media print { body { padding: 0; max-width: none; } a { color: #111; } }
  </style></head><body><h1 class="dltos-export-title">${safeTitle}</h1>${bodyHtml}</body></html>`;
}

/** The outcome of a print attempt — `ok:false` means the OS print sheet never opened (the iOS-PWA no-op). */
export interface PrintResult {
  ok: boolean;
}

/**
 * Render the note into a HIDDEN iframe and invoke the OS print/share sheet on it (the single path behind both
 * "Print" and "Export as PDF" — Save-as-PDF is the user's pick in the native sheet). The iframe (not
 * `window.print()` on the main document) keeps the app shell/dock OUT of the printout and stops the app's CSS
 * fighting the print layout.
 *
 * iOS-PWA LANDMINE: `print()` can silently NO-OP in an installed standalone PWA. We do NOT swallow that — we
 * watch for `beforeprint` (fired when the sheet actually opens) and, if it never fires within a short grace
 * window (or `print()` throws), resolve `{ ok:false }` so the caller surfaces a visible fallback.
 */
export async function printNote(note: Note): Promise<PrintResult> {
  const attachmentUrl = await buildAttachmentResolver(note.body);
  const html = buildPrintDocument(note.title, spineToHtml(note.body, { attachmentUrl }));

  return new Promise<PrintResult>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('title', 'Print preview');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';

    let settled = false;
    let opened = false;
    const cleanup = () => { try { iframe.remove(); } catch { /* already gone */ } };
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok });
      if (!ok) cleanup(); // a sheet that opened is torn down on afterprint; a no-op iframe we drop now
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) { settle(false); return; }
      // beforeprint = the sheet opened → success. afterprint = it closed → tear the iframe down.
      win.addEventListener('beforeprint', () => { opened = true; settle(true); });
      win.addEventListener('afterprint', cleanup);
      try {
        win.focus();
        win.print();
      } catch {
        settle(false);
        return;
      }
      // If the sheet opened, beforeprint already fired synchronously (desktop) or will shortly (some
      // browsers fire it async). If nothing fires within the grace window it NO-OP'd (iOS-PWA) → fallback.
      window.setTimeout(() => { if (!opened) settle(false); }, 900);
    };

    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}
