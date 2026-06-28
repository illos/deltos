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

/** Intrinsic page dimensions (CSS px at scale 1). */
export interface PdfPageDims {
  width: number;
  height: number;
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
export const RENDER_PRIORITY = { MAIN: 0, THUMBNAIL: 1 } as const;
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
 * Open a PDF from its raw bytes (§2.2 hands us the ArrayBuffer from the authenticated blob GET). The bytes
 * are wrapped in a fresh `Uint8Array` and transferred into the worker by pdf.js (§2.2 "transfer, not copy");
 * we keep no long-lived second reference to the buffer.
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
    data: new Uint8Array(data),
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
