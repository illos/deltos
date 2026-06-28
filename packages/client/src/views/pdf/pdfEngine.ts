/**
 * pdfEngine (pdf-reader.md §4.4, §7) — the main-thread handle to pdf.js. The `spellEngine`-analogue seam:
 * editor-agnostic, mockable (PdfReader imports it; the PDF-UI render test `vi.mock`s this module so the real
 * pdf.js engine never loads headlessly). It owns:
 *   - the pdf.js Web Worker lifecycle (one worker per open document) wired to the Vite-bundled, SAME-ORIGIN
 *     worker asset (NEVER a CDN — §7);
 *   - the SECURITY config on `getDocument` (§7): scripting OFF, no eval codegen, no annotation/link layer,
 *     `disableAutoFetch`/`disableStream` (we feed the full ArrayBuffer up front → pdf.js makes NO network
 *     fetches of its own), fonts/CMaps from same-origin bundled assets;
 *   - a single bounded render queue (§4.4) so a fast scroll never fans out 100 simultaneous rasterizes;
 *   - DPR-aware rendering with a hard canvas-pixel-area cap (§4.2) so a huge page on a retina screen can't
 *     allocate a runaway bitmap.
 *
 * This module statically imports `pdfjs-dist`; it is itself only ever reached through PdfReader, which
 * FileNoteView reaches via a second-level `import()`. So pdf.js is two lazy hops from first load and never
 * enters the entry bundle or FileNoteView's static graph (gate PDF-P).
 */
import * as pdfjs from 'pdfjs-dist';
// The pdf.js parser worker: Vite emits this as a hashed SAME-ORIGIN asset (renamed to `assets/pdf.worker-*.js`
// by vite.config.ts so the SW can match it). `?url` gives us the served URL; we construct the Worker ourselves
// as `{ type: 'module' }`, so the asset's extension is irrelevant to pdf.js's classic/module detection.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { toWorkerData } from './pdfBuffer.js';

/** Intrinsic page dimensions (CSS px at scale 1). */
export interface PdfPageDims {
  width: number;
  height: number;
}

/**
 * One extracted text run from a page (Slice 3 / §5). The `str` is ATTACKER-CONTROLLED text from an untrusted
 * PDF — it is carried as a plain string and only ever reaches the DOM as a React text node / `textContent`
 * (never `innerHTML`), so markup inside it stays inert. The geometry is projected into the page's scale-1 CSS-px
 * box (origin = page top-left); the reader multiplies by the page's display scale to position the inert span.
 */
export interface PdfTextItem {
  /** The text run. UNTRUSTED — render as text only, never as markup. */
  str: string;
  /** Left edge in scale-1 CSS px from the page's left. */
  left: number;
  /** Top edge in scale-1 CSS px from the page's top. */
  top: number;
  /** Run width in scale-1 CSS px. */
  width: number;
  /** Font/line height in scale-1 CSS px (drives the span's font-size). */
  height: number;
}

/** A page's extracted text (Slice 3 §5.2) — the ordered inert text runs. Cached so re-searching is cheap. */
export interface PdfPageText {
  items: PdfTextItem[];
}

/** A cancelable render of one page into one canvas. */
export interface PdfRenderHandle {
  /** Resolves when the page has finished painting; rejects with a cancel/parse error. */
  readonly promise: Promise<void>;
  /** Cancel an in-flight render (fast scroll) so render tasks don't pile up. */
  cancel(): void;
}

/**
 * Render priority for the SINGLE shared queue (§4.4). Lower number = more urgent. The visible main-viewer pages
 * (HIGH) always preempt pending thumbnails (LOW) for the next free slot, so the thumbnail rail can never starve
 * the page the user is actually reading. There is exactly one worker + one queue for both surfaces.
 */
// SEARCH (Slice 3) is the LOWEST tier — text extraction (getTextContent) for the match index funnels through the
// SAME single worker + queue, so it can never starve the visible reading pages (MAIN) OR the thumbnail renders
// (THUMBNAIL). Reading > thumbnails > search.
export const RENDER_PRIORITY = { MAIN: 0, THUMBNAIL: 1, SEARCH: 2 } as const;
export type RenderPriority = (typeof RENDER_PRIORITY)[keyof typeof RENDER_PRIORITY];

export interface RenderOptions {
  /** Queue priority — defaults to MAIN (high). Thumbnails pass THUMBNAIL (low) so they yield to the reader. */
  priority?: RenderPriority;
}

/** An opened PDF document — the handle PdfReader drives. */
export interface OpenedPdf {
  readonly numPages: number;
  /** Cheap: reads the page dict + viewport, does NOT rasterize (§4.1). */
  getPageDims(pageNumber: number): Promise<PdfPageDims>;
  /**
   * Rasterize `pageNumber` into `canvas` at `cssScale`, DPR-aware + pixel-capped (§4.2). Funnels through the
   * SINGLE bounded, priority-ordered queue (§4.4). The thumbnail rail calls this with `priority: THUMBNAIL`
   * (low) — same worker, same queue, lower priority — never a second worker / second page-load.
   */
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    cssScale: number,
    opts?: RenderOptions,
  ): PdfRenderHandle;
  /**
   * Extract `pageNumber`'s text (Slice 3 §5) via `page.getTextContent()` through the SAME bounded queue at
   * SEARCH priority (lowest) — never starves reading or thumbnails. The returned strings are UNTRUSTED PDF text;
   * the caller renders them as inert text only. Cheap relative to rasterizing; the reader caches the result.
   */
  getPageText(pageNumber: number): Promise<PdfPageText>;
  /** Cancel everything, destroy the document + terminate the worker, drop all bitmaps (§4.4 teardown). */
  destroy(): Promise<void>;
}

// Hard ceiling on a single canvas bitmap (§4.2). ~4M px ≈ a 2000×2000 canvas — plenty for fit-to-width on
// any screen, but it bounds a retina render of a large page so it can't allocate a runaway bitmap.
const MAX_CANVAS_PIXELS = 4_000_000;
// Bounded concurrency for the single worker (§4.4) — visible pages render a couple at a time, never 100.
const MAX_CONCURRENT_RENDERS = 2;

/** Same-origin bundled font/CMap assets (vite.config.ts copies them into the build; §7 — never a CDN). */
const CMAP_URL = '/pdfjs/cmaps/';
const STANDARD_FONT_DATA_URL = '/pdfjs/standard_fonts/';

function effectiveDpr(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/**
 * Project a page's `getTextContent()` result into our inert `PdfTextItem`s (Slice 3 §5.1). Each text-space run
 * is transformed by the scale-1 page viewport into a CSS-px box (left/top from the page top-left, plus the run
 * width + font height). We DROP marked-content markers (no `str`) and zero-length runs. The `str` is carried
 * verbatim and untrusted — it is NEVER interpreted as markup here, only as data the reader renders as text.
 */
function projectTextContent(
  content: { items: ReadonlyArray<unknown> },
  viewport: { transform: number[] },
): PdfPageText {
  const items: PdfTextItem[] = [];
  for (const raw of content.items) {
    const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
    if (typeof it.str !== 'string' || it.str.length === 0 || !it.transform) continue;
    // tx = viewport.transform ∘ item.transform → device coords of the run's baseline origin.
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || it.height || 0;
    items.push({
      str: it.str,
      left: tx[4] ?? 0,
      // pdf.js reports the baseline; the span's top is one font-height up.
      top: (tx[5] ?? 0) - fontHeight,
      width: it.width ?? 0,
      height: fontHeight,
    });
  }
  return { items };
}

/**
 * Open a PDF from its raw bytes (§2.2 hands us the ArrayBuffer from the authenticated blob GET). pdf.js
 * TRANSFERS the buffer into its worker, which DETACHES it on the main thread — and our blob cache returns the
 * SAME ArrayBuffer on every reopen, so we must NEVER let pdf.js detach the cached buffer. `toWorkerData` hands
 * pdf.js a fresh COPY each open; pdf.js may detach the copy, the cached buffer stays intact, and reopen works
 * (the reopen-fails-on-second-visit bug; see pdfBuffer.ts).
 */
export async function openPdf(data: ArrayBuffer): Promise<OpenedPdf> {
  // One worker per document. We build the Worker ourselves (explicit `{ type: 'module' }`) and hand pdf.js the
  // port via PDFWorker, so pdf.js never falls back to fetching a worker from `workerSrc`/a CDN (§7).
  const port = new Worker(pdfWorkerUrl, { type: 'module' });
  // The generated .d.ts types PDFWorker's `port` as `null` (lossy JSDoc); at runtime it accepts a real Worker
  // and uses it as the worker port. Cast through the constructor param to hand it our same-origin module worker.
  const worker = new pdfjs.PDFWorker(
    { port } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0],
  );

  // SECURITY CONFIG (§7 / gate PDF-S) — the heart of "parse, not execute":
  const params = {
    // A fresh COPY (never the cached buffer) — pdf.js transfers + detaches this; the cache entry survives so a
    // reopen (cache hit) still has intact bytes. (reopen-detachment fix; pdfBuffer.ts.)
    data: toWorkerData(data),
    worker,
    // Scripting OFF — NEVER execute embedded PDF JavaScript. (Default; we set it false explicitly + never load
    // the pdf.sandbox module, so the gate is auditable: this is the only `enableScripting` in the codebase.)
    enableScripting: false,
    // No eval/Function codegen surface (CSP-friendly). v6 already removed the eval font fast-path, but we pass
    // this for audit clarity + forward-compat — pdf.js ignores params it no longer reads.
    isEvalSupported: false,
    // We hand pdf.js the FULL buffer up front, so there is no range-request streaming to do — and these
    // guarantee pdf.js makes NO network fetches of its own (§7). All bytes came from our one authenticated GET.
    disableAutoFetch: true,
    disableStream: true,
    // Fonts / CMaps from SAME-ORIGIN bundled assets (never a CDN — §7).
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  };

  const loadingTask = pdfjs.getDocument(params);
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    // Failed to parse → tear the worker down so a parse error doesn't leak a worker, then rethrow for the
    // caller to degrade to the icon + Download (§3.1, gate PDF-2).
    try {
      await worker.destroy();
    } catch {
      /* already gone */
    }
    throw err;
  }

  // ---- the single bounded, PRIORITY-ordered render queue (§4.4) ----
  // One queue serves both the main viewer and the thumbnail rail. Each free worker slot is handed to the most
  // urgent pending job (lowest priority number; FIFO within a priority via `seq`), so a backlog of low-priority
  // thumbnail renders can never delay a visible main page — the reader always wins the next slot.
  interface QueuedJob {
    run: () => void;
    priority: number;
    seq: number;
  }
  const queue: QueuedJob[] = [];
  let seqCounter = 0;
  let active = 0;
  const pump = () => {
    while (active < MAX_CONCURRENT_RENDERS && queue.length) {
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        const cand = queue[i]!;
        const best = queue[bestIdx]!;
        if (cand.priority < best.priority || (cand.priority === best.priority && cand.seq < best.seq)) {
          bestIdx = i;
        }
      }
      const job = queue.splice(bestIdx, 1)[0]!;
      active++;
      job.run();
    }
  };
  const release = () => {
    active--;
    pump();
  };
  // Generic submit: `start` runs when a slot is free and MUST call `release()` exactly once when its work
  // settles. Both renderPage (MAIN/THUMBNAIL) and getPageText (SEARCH) submit through this one queue, so all
  // worker work is priority-ordered and concurrency-bounded together.
  const enqueue = (priority: number, start: () => void) => {
    queue.push({ run: start, priority, seq: seqCounter++ });
    pump();
  };

  let destroyed = false;

  return {
    numPages: doc.numPages,

    async getPageDims(pageNumber: number): Promise<PdfPageDims> {
      const page = await doc.getPage(pageNumber);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },

    renderPage(
      pageNumber: number,
      canvas: HTMLCanvasElement,
      cssScale: number,
      opts?: RenderOptions,
    ): PdfRenderHandle {
      const priority = opts?.priority ?? RENDER_PRIORITY.MAIN;
      let canceled = false;
      let task: pdfjs.RenderTask | null = null;

      const promise = new Promise<void>((resolve, reject) => {
        const run = () => {
          if (canceled || destroyed) {
            release();
            reject(new Error('render canceled'));
            return;
          }
          doc
            .getPage(pageNumber)
            .then((page) => {
              if (canceled || destroyed) throw new Error('render canceled');
              // DPR for crispness, but clamp so width·height·(scale·dpr)² never exceeds the pixel cap (§4.2).
              const dpr = effectiveDpr();
              const base = page.getViewport({ scale: cssScale });
              let renderScale = cssScale * dpr;
              const capScale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
              if (cssScale * dpr > capScale) renderScale = capScale;
              const viewport = page.getViewport({ scale: renderScale });

              canvas.width = Math.floor(viewport.width);
              canvas.height = Math.floor(viewport.height);
              // CSS lays the canvas out at the fit size; the extra device pixels just sharpen it.
              canvas.style.width = `${Math.floor(base.width)}px`;
              canvas.style.height = `${Math.floor(base.height)}px`;

              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('no 2d context');
              task = page.render({ canvas, canvasContext: ctx, viewport });
              return task.promise;
            })
            .then(() => {
              release();
              resolve();
            })
            .catch((err) => {
              release();
              reject(err);
            });
        };
        queue.push({ run, priority, seq: seqCounter++ });
        pump();
      });

      return {
        promise,
        cancel() {
          canceled = true;
          if (task) {
            try {
              task.cancel();
            } catch {
              /* already settled */
            }
          }
        },
      };
    },

    getPageText(pageNumber: number): Promise<PdfPageText> {
      return new Promise<PdfPageText>((resolve, reject) => {
        const start = () => {
          if (destroyed) {
            release();
            reject(new Error('destroyed'));
            return;
          }
          doc
            .getPage(pageNumber)
            .then(async (page) => {
              // The scale-1 viewport gives the transform that projects text-space → page CSS box (§5.1).
              const viewport = page.getViewport({ scale: 1 });
              const content = await page.getTextContent();
              return projectTextContent(content, viewport);
            })
            .then((pageText) => {
              release();
              resolve(pageText);
            })
            .catch((err) => {
              release();
              reject(err);
            });
        };
        // SEARCH = lowest priority: text extraction yields to every visible page + every thumbnail render.
        enqueue(RENDER_PRIORITY.SEARCH, start);
      });
    },

    async destroy(): Promise<void> {
      destroyed = true;
      queue.length = 0;
      // loadingTask.destroy() aborts in-flight work + tears down the document (the PDFDocumentProxy has no
      // public destroy in v6; the loading task owns teardown). Then terminate our worker (guarded — idempotent).
      try {
        await loadingTask.destroy();
      } catch {
        /* already gone */
      }
      try {
        worker.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}
