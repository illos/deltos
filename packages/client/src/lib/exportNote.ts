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
 * (via the shared `spineToHtml` rendered into a print-only container on the MAIN document → the OS
 * print/share sheet). Everything here is reached ONLY from the lazy ExportSection (in the combined
 * ShareExportPanel chunk), so it never enters the mobile first-load bundle.
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

/**
 * The print stylesheet. Two jobs:
 *   1. On SCREEN, `.dltos-print-root` is `display:none` — the injected note container is never visible in-app.
 *   2. In PRINT, hide the ENTIRE app (`#root` + any portals are direct `<body>` children) with
 *      `body > *:not(.dltos-print-root)` and reveal only our container, then apply readable typography
 *      SCOPED under `.dltos-print-root` so none of it can leak onto the live app. The app itself ships NO
 *      `@media print` rules, so there are no conflicting print styles to fight.
 */
const PRINT_CSS = `
.dltos-print-root { display: none; }
@media print {
  body > *:not(.dltos-print-root) { display: none !important; }
  .dltos-print-root { display: block !important; }
  @page { margin: 18mm; }
  .dltos-print-root {
    color-scheme: light;
    background: #fff; color: #111;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 44rem;
  }
  .dltos-print-root * { box-sizing: border-box; }
  .dltos-print-root h1, .dltos-print-root h2, .dltos-print-root h3,
  .dltos-print-root h4, .dltos-print-root h5, .dltos-print-root h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  .dltos-print-root h1 { font-size: 1.9rem; }
  .dltos-print-root h2 { font-size: 1.5rem; }
  .dltos-print-root h3 { font-size: 1.25rem; }
  .dltos-print-root p, .dltos-print-root ul, .dltos-print-root ol,
  .dltos-print-root blockquote, .dltos-print-root pre { margin: 0.6em 0; }
  .dltos-print-root ul, .dltos-print-root ol { padding-left: 1.5rem; }
  .dltos-print-root blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #444; }
  .dltos-print-root pre { background: #f5f5f5; padding: 0.8rem 1rem; border-radius: 6px; overflow-x: auto; }
  .dltos-print-root code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  .dltos-print-root pre code { font-size: 0.85rem; }
  .dltos-print-root hr { border: 0; border-top: 1px solid #ddd; margin: 1.5em 0; }
  .dltos-print-root img { max-width: 100%; height: auto; }
  .dltos-print-root mark { background: #fff2a8; }
  .dltos-print-root a { color: #111; text-decoration: underline; }
  .dltos-print-root .dltos-todo { list-style: none; }
  .dltos-print-root .dltos-todo input { margin-right: 0.4em; }
  .dltos-print-root h1.dltos-export-title { margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
}
`;

/** The outcome of a print attempt — `ok:false` means the OS print sheet never opened (the iOS-PWA no-op). */
export interface PrintResult {
  ok: boolean;
}

/**
 * Print / Save-as-PDF the open note (the single path behind both "Print" and "Export as PDF" — Save-as-PDF is
 * the user's pick in the native sheet).
 *
 * WHY the MAIN document and NOT a hidden iframe (do NOT "simplify" this back): on iOS Safari / an installed
 * standalone PWA, `iframe.contentWindow.print()` is IGNORED — iOS always prints the TOP-LEVEL document. The old
 * iframe path therefore printed the (blank-under-print) app shell, and the saved-PDF filename came out as the
 * top document's `<title>` ("deltos"), never the note. So instead we:
 *   - inject a print-only `.dltos-print-root` container (a sibling of `#root`) holding the note's rendered HTML,
 *   - inject `@media print` CSS that hides the whole app and shows only that container,
 *   - swap `document.title` to the note title BEFORE printing (this drives the Save-as-PDF filename on desktop
 *     AND iOS), restoring it only AFTER the print interaction ends,
 *   - and call `window.print()` on the MAIN window.
 *
 * iOS-PWA LANDMINE: `print()` can silently NO-OP in an installed standalone PWA. We do NOT swallow that — we
 * watch for `beforeprint` (fired when the sheet actually opens) and, if it never fires within a short grace
 * window (or `print()` throws), resolve `{ ok:false }` so the caller surfaces a visible fallback.
 */
export async function printNote(note: Note): Promise<PrintResult> {
  const attachmentUrl = await buildAttachmentResolver(note.body);
  const bodyHtml = spineToHtml(note.body, { attachmentUrl });
  const title = note.title.trim() || 'Untitled';

  // Inject the print-only container (sibling of #root) + its stylesheet.
  const container = document.createElement('div');
  container.className = 'dltos-print-root';
  container.innerHTML = `<h1 class="dltos-export-title">${escapeHtmlText(title)}</h1>${bodyHtml}`;

  const style = document.createElement('style');
  style.setAttribute('data-dltos-print', '');
  style.textContent = PRINT_CSS;

  document.body.appendChild(style);
  document.body.appendChild(container);

  // Swap the document title so the Save-as-PDF filename is the note title (not the app's "deltos"). Restored
  // ONLY once the print interaction ends — restoring while the sheet is still open would change the filename
  // mid-save.
  const prevTitle = document.title;
  document.title = title;

  return new Promise<PrintResult>((resolve) => {
    let settled = false;
    let cleaned = false;
    let opened = false;
    let graceTimer = 0;
    let safetyTimer = 0;

    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok });
    };

    // Idempotent teardown: restore the title, drop the container + style, unwire everything. Runs EXACTLY once.
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.title = prevTitle;
      try { container.remove(); } catch { /* already gone */ }
      try { style.remove(); } catch { /* already gone */ }
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
      window.removeEventListener('focus', onFocus);
      if (graceTimer) window.clearTimeout(graceTimer);
      if (safetyTimer) window.clearTimeout(safetyTimer);
    };

    const onBeforePrint = () => { opened = true; settle(true); };
    const onAfterPrint = () => cleanup();
    const onFocus = () => cleanup();

    // beforeprint = the sheet opened → success. afterprint = it closed → tear down. iOS frequently NEVER fires
    // afterprint, so we ALSO tear down on the next `focus` (the user returning to the page) and on a safety
    // timeout. All three fire only after the user is back, so the title restore never races the open sheet.
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);

    try {
      window.print();
    } catch {
      // print() threw → nothing opened; safe to tear down + restore immediately.
      settle(false);
      cleanup();
      return;
    }

    if (!cleaned) {
      window.addEventListener('focus', onFocus);
      safetyTimer = window.setTimeout(cleanup, 10000);
    }

    // No-op detection: if beforeprint never fired within the grace window, the sheet never opened (iOS-PWA
    // no-op) → resolve ok:false so the caller shows the visible fallback. The safety timeout / focus still
    // tears the container down afterward.
    graceTimer = window.setTimeout(() => { if (!opened) settle(false); }, 900);
  });
}
