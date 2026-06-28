import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { loadBlobBytes } from '../../plugins/attachment/blobClient.js';
import { openPdf, type OpenedPdf, type PdfPageDims } from './pdfEngine.js';

/**
 * PdfReader (pdf-reader.md §3.1, §4 — Slice 1) — the lazy in-app PDF viewer mounted in FileNoteView's preview
 * region for `pdf`-type file notes. It is reached ONLY via a second-level `import()` inside FileNoteView's pdf
 * branch (never a static import), so pdf.js stays out of the entry bundle and out of FileNoteView's static
 * graph (gate PDF-P).
 *
 * Slice 1 = a scrollable, VIRTUALIZED multi-page canvas viewer:
 *   - on open, fetch each page's intrinsic dimensions (cheap — no rasterize, §4.1) to lay out exact
 *     placeholder offsets + a correct total scroll height, even for a 500-page doc;
 *   - render only the pages near the viewport (+buffer) to live canvases via an IntersectionObserver window;
 *     off-screen pages revert to placeholder boxes and their canvases are destroyed (§4.2) — bounded memory
 *     regardless of page count;
 *   - fit-to-width, DPR-aware with a hard pixel cap (in pdfEngine, §4.2);
 *   - graceful degrade: a parse error or offline-miss falls back to the icon + Download (§3.1, gate PDF-2),
 *     it never breaks the surrounding FileNoteView chrome.
 *
 * Thumbnails (Slice 2), jump-to-page (Slice 2), and search/text-layer (Slice 3) are NOT in this slice.
 */

interface PdfReaderProps {
  hash: string;
  name: string;
  /** Rendered when the engine can't open the PDF (offline/parse-fail) — the icon + Download fallback. */
  onDownload: () => void;
}

// How many CSS px above/below the viewport count as "in window" (the ±1–2 page buffer, §4.2). Generous so a
// fast flick doesn't outrun the renderer.
const WINDOW_BUFFER_PX = 1200;
const PAGE_GAP_PX = 12;
// Fit-to-width target is the container width clamped so a very wide page doesn't render an enormous canvas.
const MAX_PAGE_CSS_WIDTH = 1400;
// Default aspect (height/width) used for not-yet-measured pages until their real dims arrive (§4.1).
const DEFAULT_ASPECT = 1.4142; // ~ISO A-series portrait

export function PdfReader({ hash, name, onDownload }: PdfReaderProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [opened, setOpened] = useState<OpenedPdf | null>(null);
  // Per-page intrinsic dims; null until measured. Length === numPages once open.
  const [dims, setDims] = useState<Array<PdfPageDims | null>>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [currentPage, setCurrentPage] = useState(1);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // --- open: bytes (authenticated GET) → pdf.js parse. Either branch failing → degrade (gate PDF-2). ---
  useEffect(() => {
    let alive = true;
    let doc: OpenedPdf | null = null;
    setPhase('loading');
    setOpened(null);
    setDims([]);
    setVisible(new Set([1]));
    setCurrentPage(1);

    (async () => {
      try {
        const bytes = await loadBlobBytes(hash);
        const pdf = await openPdf(bytes);
        if (!alive) {
          void pdf.destroy();
          return;
        }
        doc = pdf;
        setOpened(pdf);
        setDims(new Array(pdf.numPages).fill(null));
        setPhase('ready');
      } catch {
        if (alive) setPhase('error');
      }
    })();

    return () => {
      alive = false;
      if (doc) void doc.destroy();
    };
  }, [hash]);

  // --- progressively fetch page dims (cheap viewport reads, §4.1), in batches to bound re-renders. Page 1
  //     first so the first estimate is real; the rest stream in and the layout reconciles. ---
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    const total = opened.numPages;
    (async () => {
      const BATCH = 12;
      for (let start = 1; start <= total; start += BATCH) {
        const ends = Math.min(start + BATCH - 1, total);
        const got = await Promise.all(
          Array.from({ length: ends - start + 1 }, (_, k) =>
            opened.getPageDims(start + k).catch(() => null),
          ),
        );
        if (!alive) return;
        setDims((prev) => {
          const next = prev.slice();
          for (let i = 0; i < got.length; i++) next[start - 1 + i] = got[i] ?? null;
          return next;
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [opened]);

  // --- container width (fit-to-width target), tracked across resize. ---
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

  // Median aspect of measured pages → the estimate for unmeasured ones (keeps scroll height ~correct, §4.1).
  const medianAspect = useMemo(() => {
    const aspects = dims.filter((d): d is PdfPageDims => !!d).map((d) => d.height / d.width);
    if (!aspects.length) return DEFAULT_ASPECT;
    aspects.sort((a, b) => a - b);
    return aspects[Math.floor(aspects.length / 2)] ?? DEFAULT_ASPECT;
  }, [dims]);

  // Fit-to-width target width (the displayed width of every page).
  const targetWidth = Math.min(containerWidth || 0, MAX_PAGE_CSS_WIDTH);

  // Per-page layout: displayed height + cumulative offset. Exact for measured pages, estimated otherwise — so
  // the scrollbar + offsets are known for every page even though 99% are never rasterized (§4.1).
  const layout = useMemo(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    const scales: number[] = [];
    let y = 0;
    for (let i = 0; i < dims.length; i++) {
      const d = dims[i] ?? null;
      const aspect = d ? d.height / d.width : medianAspect;
      const scale = d && targetWidth ? targetWidth / d.width : 0;
      const h = targetWidth ? aspect * targetWidth : 0;
      offsets[i] = y;
      heights[i] = h;
      scales[i] = scale;
      y += h + PAGE_GAP_PX;
    }
    return { heights, offsets, scales, totalHeight: y };
  }, [dims, medianAspect, targetWidth]);

  // --- the render window: which page indices have live canvases. Recomputed from scroll position against the
  //     known offsets (+buffer). Plain scroll math — exact and IO-free, so it works in any environment. ---
  const recomputeWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout.heights.length) return;
    const top = el.scrollTop - WINDOW_BUFFER_PX;
    const bottom = el.scrollTop + el.clientHeight + WINDOW_BUFFER_PX;
    const next = new Set<number>();
    let cur = 1;
    for (let i = 0; i < layout.offsets.length; i++) {
      const pageTop = layout.offsets[i] ?? 0;
      const pageBottom = pageTop + (layout.heights[i] ?? 0);
      if (pageBottom >= top && pageTop <= bottom) next.add(i + 1);
      // current page = the one straddling the viewport's vertical middle.
      if (pageTop <= el.scrollTop + el.clientHeight / 2) cur = i + 1;
    }
    if (next.size === 0) next.add(1);
    setVisible((prev) => (sameSet(prev, next) ? prev : next));
    setCurrentPage((prev) => (prev === cur ? prev : cur));
  }, [layout]);

  // Recompute on scroll, and whenever layout (dims/width) changes.
  useEffect(() => {
    recomputeWindow();
  }, [recomputeWindow]);

  const onScroll = useCallback(() => recomputeWindow(), [recomputeWindow]);

  if (phase === 'error') {
    return (
      <div className="pdf-reader pdf-reader--error">
        <p className="pdf-reader__error-msg">Couldn’t open this PDF.</p>
        <button type="button" className="pdf-reader__download" onClick={onDownload}>
          Download to view
        </button>
      </div>
    );
  }

  return (
    <div className="pdf-reader">
      <div className="pdf-reader__toolbar">
        <span className="pdf-reader__pageinfo" aria-live="polite">
          {opened ? `${currentPage} / ${opened.numPages}` : '…'}
        </span>
        <span className="pdf-reader__filename" title={name}>
          {name}
        </span>
      </div>

      <div className="pdf-reader__scroll" ref={scrollRef} onScroll={onScroll}>
        {phase === 'loading' && <div className="pdf-reader__spinner" role="status">Opening…</div>}
        {opened && (
          <div className="pdf-reader__pages" style={{ height: layout.totalHeight || undefined }}>
            {Array.from({ length: opened.numPages }, (_, i) => {
              const pageNumber = i + 1;
              const pageScale = layout.scales[i] ?? 0;
              const isLive = visible.has(pageNumber) && pageScale > 0;
              return (
                <div
                  key={pageNumber}
                  className="pdf-reader__page"
                  data-page={pageNumber}
                  style={{
                    position: 'absolute',
                    top: layout.offsets[i] ?? 0,
                    width: targetWidth || undefined,
                    height: layout.heights[i] || undefined,
                  }}
                >
                  {isLive ? (
                    <PdfPageCanvas opened={opened} pageNumber={pageNumber} cssScale={pageScale} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One live page canvas. Mounting === "page entered the window" → request a render through the engine's bounded
 * queue. Unmounting === "page left the window" → cancel the in-flight render and zero the bitmap so the GC
 * reclaims it (§4.2). Keyed by page so a scroll-out/scroll-back cleanly re-renders.
 */
function PdfPageCanvas({
  opened,
  pageNumber,
  cssScale,
}: {
  opened: OpenedPdf;
  pageNumber: number;
  cssScale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = opened.renderPage(pageNumber, canvas, cssScale);
    handle.promise.catch(() => {
      /* canceled or parse error for this page — the placeholder simply stays blank */
    });
    return () => {
      handle.cancel();
      // Drop the bitmap (§4.2): zeroing the backing store frees the GPU/CPU memory immediately.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [opened, pageNumber, cssScale]);

  return <canvas ref={canvasRef} className="pdf-reader__canvas" />;
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export default PdfReader;
