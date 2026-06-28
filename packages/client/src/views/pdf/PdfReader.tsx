import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { loadBlobBytes } from '../../plugins/attachment/blobClient.js';
import { useIsDesktop } from '../../lib/useIsDesktop.js';
import { openPdf, RENDER_PRIORITY, type OpenedPdf, type PdfPageDims, type PdfPageText } from './pdfEngine.js';
import {
  buildMatches,
  pagePlainText,
  splitItemForRender,
  type PdfMatch,
} from './pdfSearch.js';

/**
 * PdfReader (pdf-reader.md §3 — Slice 1 + Slice 2) — the lazy in-app PDF viewer mounted in FileNoteView's
 * preview region for `pdf`-type file notes. It is reached ONLY via a second-level `import()` inside
 * FileNoteView's pdf branch (never a static import), so pdf.js stays out of the entry bundle and out of
 * FileNoteView's static graph (gate PDF-P).
 *
 * Slice 1 = a scrollable, VIRTUALIZED multi-page canvas viewer:
 *   - on open, fetch each page's intrinsic dimensions (cheap — no rasterize, §4.1) to lay out exact
 *     placeholder offsets + a correct total scroll height, even for a 500-page doc;
 *   - render only the pages near the viewport (+buffer) to live canvases via a scroll-position window;
 *     off-screen pages revert to placeholder boxes and their canvases are destroyed (§4.2) — bounded memory
 *     regardless of page count;
 *   - fit-to-width, DPR-aware with a hard pixel cap (in pdfEngine, §4.2);
 *   - graceful degrade: a parse error or offline-miss falls back to the icon + Download (§3.1, gate PDF-2),
 *     it never breaks the surrounding FileNoteView chrome.
 *
 * Slice 2 (this) adds, on TOP of that viewer — no second worker, no second page-load:
 *   - a VIRTUALIZED thumbnail rail (§3.2, §4.3): reuses the same per-page dims + scroll-window discipline, renders
 *     low-res previews only for thumbnails near the rail viewport, and submits them to the SAME bounded engine
 *     queue at LOW priority (RENDER_PRIORITY.THUMBNAIL) so they never starve the main reading view (§4.4);
 *   - a shared JUMP primitive (§3.3): `scrollToPage(n)` computes page n's exact offset from the precomputed
 *     layout and scrolls the viewer there; the window then rasterizes around it. Driven by both a thumbnail tap
 *     and a toolbar page-number input + prev/next chevrons (clamped to [1, numPages]);
 *   - mobile treatment (§3.2 / OQ-2): a docked side rail on desktop; a toggleable drawer/overlay on mobile so the
 *     rail never permanently eats reading width. Toggled by the `≡` toolbar button.
 *
 * Search/text-layer (Slice 3) is NOT in this slice.
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

// Thumbnail rail geometry (§3.2, §4.3): a narrow column of low-res previews ~108 CSS px wide, windowed the same
// way as the main viewer with its own (smaller) above/below buffer.
const THUMB_CSS_WIDTH = 108;
const THUMB_GAP_PX = 10;
const THUMB_WINDOW_BUFFER_PX = 600;

export function PdfReader({ hash, name, onDownload }: PdfReaderProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [opened, setOpened] = useState<OpenedPdf | null>(null);
  // Per-page intrinsic dims; null until measured. Length === numPages once open.
  const [dims, setDims] = useState<Array<PdfPageDims | null>>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [currentPage, setCurrentPage] = useState(1);

  // --- Slice 3 (search): per-page extracted text cache (null = not yet extracted), the find-bar state, and the
  //     active-match cursor. The cache is also what feeds the inert text layer (selection/copy) on visible pages. ---
  const [pageTexts, setPageTexts] = useState<Array<PdfPageText | null>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  // Pages with an in-flight getPageText, so we never double-extract (the cache + this set are the dedup).
  const pageTextInflight = useRef<Set<number>>(new Set());

  const isDesktop = useIsDesktop();
  // Mobile (OQ-2): rail OFF by default — it opens as a drawer/overlay so it never eats reading width. Desktop:
  // rail docked open by default. The `≡` toolbar button toggles either treatment.
  const [showThumbs, setShowThumbs] = useState(isDesktop);
  useEffect(() => {
    setShowThumbs(isDesktop);
  }, [isDesktop]);

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
    setPageTexts([]);
    setSearchOpen(false);
    setQuery('');
    setActiveMatch(0);
    pageTextInflight.current.clear();

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
        setPageTexts(new Array(pdf.numPages).fill(null));
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

  // --- the SHARED jump primitive (§3.3) — used by both the toolbar page control and a thumbnail tap. Compute
  //     page n's exact offset from the precomputed layout and scroll there; the window then rasterizes around it.
  //     Clamped to [1, numPages]. Recompute synchronously so the readout/window update even where setting
  //     scrollTop doesn't fire a scroll event (jsdom / programmatic scroll). ---
  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const el = scrollRef.current;
      if (!el || !opened) return;
      const clamped = Math.max(1, Math.min(opened.numPages, Math.round(pageNumber)));
      const offset = layout.offsets[clamped - 1] ?? 0;
      el.scrollTop = offset;
      recomputeWindow();
    },
    [opened, layout, recomputeWindow],
  );

  // ===================== Slice 3: text extraction + the match index (§5.2) =====================
  // Latest-value refs so the extraction/jump callbacks stay stable (no churn) while reading fresh state.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pageTextsRef = useRef(pageTexts);
  pageTextsRef.current = pageTexts;

  // Extract one page's text through the engine's SEARCH-priority queue and cache it. Idempotent: a cached or
  // in-flight page is skipped, so the visible-page effect and the full-index effect can both call it freely.
  const requestPageText = useCallback(
    (pageNumber: number) => {
      if (!opened) return;
      if (pageTextsRef.current[pageNumber - 1]) return;
      if (pageTextInflight.current.has(pageNumber)) return;
      pageTextInflight.current.add(pageNumber);
      opened
        .getPageText(pageNumber)
        .then((pt) => {
          setPageTexts((prev) => {
            if (prev[pageNumber - 1]) return prev;
            const next = prev.slice();
            next[pageNumber - 1] = pt;
            return next;
          });
        })
        .catch(() => {
          /* extraction failed for this page — it simply contributes no matches / no text layer */
        })
        .finally(() => {
          pageTextInflight.current.delete(pageNumber);
        });
    },
    [opened],
  );

  // Visible pages always get their text extracted → the inert text layer (selection/copy) + a head start on the
  // index. SEARCH priority means this never delays the canvas the user is reading.
  useEffect(() => {
    if (!opened) return;
    for (const p of visible) requestPageText(p);
  }, [opened, visible, requestPageText]);

  // When a search is active, lazily extract the WHOLE document so "x of N" is a true total. Built off the
  // first-paint path (only kicks in once the user opens search + types), page by page, deduped (§5.2 / gate PDF-6).
  useEffect(() => {
    if (!opened || !searchOpen || query.trim() === '') return;
    for (let n = 1; n <= opened.numPages; n++) requestPageText(n);
  }, [opened, searchOpen, query, requestPageText]);

  // The flat, document-ordered match list. Recomputed from the (growing) text cache + the query — so searching
  // before indexing finishes returns what's known so far and grows as pages complete.
  const matches = useMemo(
    () => (searchOpen ? buildMatches(pageTexts, query) : []),
    [searchOpen, pageTexts, query],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, PdfMatch[]>();
    for (const m of matches) {
      const arr = byPage.get(m.pageIndex);
      if (arr) arr.push(m);
      else byPage.set(m.pageIndex, [m]);
    }
    return byPage;
  }, [matches]);

  const clampedActive = matches.length ? Math.min(Math.max(activeMatch, 0), matches.length - 1) : 0;
  const activeMatchObj: PdfMatch | null = matches.length ? matches[clampedActive] ?? null : null;
  // Is the document still being indexed for the current query? (some page in range not yet extracted.)
  const indexing =
    searchOpen && query.trim() !== '' && !!opened && pageTexts.slice(0, opened.numPages).some((t) => t === null);

  // Jump to a match (§5.3): reuse the Slice-2 `scrollToPage` primitive to bring the match's page into the render
  // window, THEN refine the scroll so the match sits centered. If the page's text isn't cached yet (a match on a
  // not-yet-extracted page can't happen — matches only exist for cached pages — but the page may have scrolled
  // out), we still land on the page; the highlight paints once its text layer is ready.
  const scrollToMatch = useCallback(
    (m: PdfMatch) => {
      scrollToPage(m.pageIndex + 1);
      const el = scrollRef.current;
      const pt = pageTextsRef.current[m.pageIndex];
      const lay = layoutRef.current;
      if (!el || !pt) return;
      const scale = lay.scales[m.pageIndex] ?? 0;
      const pageTop = lay.offsets[m.pageIndex] ?? 0;
      if (scale <= 0) return;
      const { itemStarts } = pagePlainText(pt.items);
      // The item whose run contains the match start (the last item starting at/before charStart).
      let idx = 0;
      for (let i = 0; i < itemStarts.length; i++) {
        if ((itemStarts[i] ?? 0) <= m.charStart) idx = i;
        else break;
      }
      const item = pt.items[idx];
      if (!item) return;
      const itemTopPx = pageTop + item.top * scale;
      const target = itemTopPx - el.clientHeight / 2 + (item.height * scale) / 2;
      el.scrollTop = Math.max(0, target);
      recomputeWindow();
    },
    [scrollToPage, recomputeWindow],
  );

  // Select match #idx (wrapping) → set the cursor + jump to it. The single path used by next/prev and the
  // auto-jump-to-first-result effect.
  const selectMatch = useCallback(
    (idx: number) => {
      const list = matchesRef.current;
      if (!list.length) return;
      const i = ((idx % list.length) + list.length) % list.length;
      setActiveMatch(i);
      const m = list[i];
      if (m) scrollToMatch(m);
    },
    [scrollToMatch],
  );

  // Auto-jump to the FIRST match once a new query's results are available (handles async indexing: fires once,
  // when matches go 0→N for this exact query). Manual next/prev afterwards won't retrigger it.
  const lastJumpedQuery = useRef('');
  useEffect(() => {
    if (!searchOpen) return;
    if (query.trim() === '') {
      lastJumpedQuery.current = '';
      return;
    }
    if (matches.length === 0) return;
    if (lastJumpedQuery.current === query) return;
    lastJumpedQuery.current = query;
    selectMatch(0);
  }, [searchOpen, query, matches, selectMatch]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setActiveMatch(0);
    lastJumpedQuery.current = '';
  }, []);

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

  const railOpen = showThumbs && !!opened;

  return (
    <div
      className={
        'pdf-reader' +
        (isDesktop ? ' pdf-reader--desktop' : ' pdf-reader--mobile') +
        (railOpen ? ' pdf-reader--thumbs-open' : '')
      }
    >
      <div className="pdf-reader__toolbar">
        <button
          type="button"
          className={'pdf-reader__thumbs-toggle' + (railOpen ? ' is-on' : '')}
          aria-pressed={railOpen}
          aria-label={railOpen ? 'Hide page thumbnails' : 'Show page thumbnails'}
          title="Page thumbnails"
          onClick={() => setShowThumbs((v) => !v)}
          disabled={!opened}
        >
          ≡
        </button>

        <PdfPageControl
          currentPage={currentPage}
          numPages={opened ? opened.numPages : 0}
          onJump={scrollToPage}
        />

        <span className="pdf-reader__filename" title={name}>
          {name}
        </span>

        <button
          type="button"
          className={'pdf-reader__search-toggle' + (searchOpen ? ' is-on' : '')}
          aria-pressed={searchOpen}
          aria-label={searchOpen ? 'Close search' : 'Search'}
          title="Search"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          disabled={!opened}
        >
          🔍
        </button>
      </div>

      {searchOpen && opened && (
        <PdfSearchBar
          query={query}
          onQueryChange={(v) => {
            setQuery(v);
            setActiveMatch(0);
          }}
          matchCount={matches.length}
          activeIndex={matches.length ? clampedActive : -1}
          indexing={indexing}
          onNext={() => selectMatch(clampedActive + 1)}
          onPrev={() => selectMatch(clampedActive - 1)}
          onClose={closeSearch}
        />
      )}

      <div className="pdf-reader__body">
        {railOpen && opened && (
          <>
            {!isDesktop && (
              <div
                className="pdf-reader__thumbs-backdrop"
                aria-hidden="true"
                onClick={() => setShowThumbs(false)}
              />
            )}
            <PdfThumbnailRail
              opened={opened}
              dims={dims}
              medianAspect={medianAspect}
              currentPage={currentPage}
              onJump={(p) => {
                scrollToPage(p);
                if (!isDesktop) setShowThumbs(false);
              }}
            />
          </>
        )}

        <div className="pdf-reader__scroll" ref={scrollRef} onScroll={onScroll}>
          {phase === 'loading' && <div className="pdf-reader__spinner" role="status">Opening…</div>}
          {opened && (
            <div className="pdf-reader__pages" style={{ height: layout.totalHeight || undefined }}>
              {Array.from({ length: opened.numPages }, (_, i) => {
                const pageNumber = i + 1;
                const pageScale = layout.scales[i] ?? 0;
                const isLive = visible.has(pageNumber) && pageScale > 0;
                const pageText = pageTexts[i] ?? null;
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
                      <>
                        <PdfPageCanvas opened={opened} pageNumber={pageNumber} cssScale={pageScale} />
                        {/* Inert text layer (§5.1) for the windowed page only — selection/copy + search
                            highlight. Torn down with the page when it leaves the window (virtualized). */}
                        {pageText && (
                          <PdfTextLayer
                            pageText={pageText}
                            cssScale={pageScale}
                            matches={matchesByPage.get(i) ?? EMPTY_MATCHES}
                            activeMatch={activeMatchObj && activeMatchObj.pageIndex === i ? activeMatchObj : null}
                          />
                        )}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The toolbar page control (§3.3): an editable `N` field + `/ total` readout + prev/next chevrons. The field
 * shows the live current page when idle; while focused it holds the user's draft so the readout doesn't fight
 * their typing. Commit (Enter / blur) parses, clamps to [1, total], and fires the shared jump primitive.
 */
function PdfPageControl({
  currentPage,
  numPages,
  onJump,
}: {
  currentPage: number;
  numPages: number;
  onJump: (pageNumber: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) onJump(n);
    setDraft(null);
  };

  return (
    <span className="pdf-reader__pageinfo" aria-live="polite">
      <button
        type="button"
        className="pdf-reader__pagestep"
        aria-label="Previous page"
        onClick={() => onJump(currentPage - 1)}
        disabled={numPages === 0 || currentPage <= 1}
      >
        ‹
      </button>
      <input
        className="pdf-reader__pageinput"
        type="text"
        inputMode="numeric"
        aria-label="Page number"
        value={draft ?? (numPages ? String(currentPage) : '…')}
        disabled={numPages === 0}
        onFocus={() => setDraft(String(currentPage))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="pdf-reader__pagetotal">/ {numPages || '…'}</span>
      <button
        type="button"
        className="pdf-reader__pagestep"
        aria-label="Next page"
        onClick={() => onJump(currentPage + 1)}
        disabled={numPages === 0 || currentPage >= numPages}
      >
        ›
      </button>
    </span>
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

/**
 * The virtualized thumbnail rail (§3.2, §4.3). Mirrors the main viewer's discipline exactly, but at a tiny scale:
 *   - reuses the SAME per-page `dims` (no second page-load) to lay out one fixed-width thumb per page at its true
 *     aspect, so the rail's scroll height + every thumb's offset are exact for an N-page doc;
 *   - renders an interactive `<button>` placeholder for ALL N pages (so jump-to-any-page works), but only the
 *     thumbs near the rail's scroll window hold a live canvas — off-window thumbs are empty boxes, their bitmaps
 *     destroyed (§4.3);
 *   - submits thumb renders to the SAME engine queue at LOW priority (RENDER_PRIORITY.THUMBNAIL) — one worker,
 *     one queue, thumbnails yield to the reader (§4.4);
 *   - highlights the current page's thumb and keeps it scrolled into view as the reader scrolls.
 */
function PdfThumbnailRail({
  opened,
  dims,
  medianAspect,
  currentPage,
  onJump,
}: {
  opened: OpenedPdf;
  dims: Array<PdfPageDims | null>;
  medianAspect: number;
  currentPage: number;
  onJump: (pageNumber: number) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railWindow, setRailWindow] = useState<Set<number>>(() => new Set([1]));

  // Thumb layout: fixed width, height from each page's true aspect (estimate until measured) — same math as the
  // main column, just a different (constant) width.
  const layout = useMemo(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    let y = 0;
    for (let i = 0; i < opened.numPages; i++) {
      const d = dims[i] ?? null;
      const aspect = d ? d.height / d.width : medianAspect;
      const h = aspect * THUMB_CSS_WIDTH;
      offsets[i] = y;
      heights[i] = h;
      y += h + THUMB_GAP_PX;
    }
    return { heights, offsets, totalHeight: y };
  }, [opened.numPages, dims, medianAspect]);

  const recompute = useCallback(() => {
    const el = railRef.current;
    if (!el || !layout.heights.length) return;
    const top = el.scrollTop - THUMB_WINDOW_BUFFER_PX;
    const bottom = el.scrollTop + el.clientHeight + THUMB_WINDOW_BUFFER_PX;
    const next = new Set<number>();
    for (let i = 0; i < layout.offsets.length; i++) {
      const t = layout.offsets[i] ?? 0;
      const b = t + (layout.heights[i] ?? 0);
      if (b >= top && t <= bottom) next.add(i + 1);
    }
    if (next.size === 0) next.add(1);
    setRailWindow((prev) => (sameSet(prev, next) ? prev : next));
  }, [layout]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  // Keep the current page's thumb in view as the reader scrolls (only nudge when it's actually off-screen, so we
  // don't fight a user scrubbing the rail).
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const top = layout.offsets[currentPage - 1] ?? 0;
    const h = layout.heights[currentPage - 1] ?? 0;
    const viewTop = el.scrollTop;
    const viewBottom = el.scrollTop + el.clientHeight;
    if (top < viewTop) el.scrollTop = top;
    else if (top + h > viewBottom) el.scrollTop = top + h - el.clientHeight;
  }, [currentPage, layout]);

  const thumbScale = useMemo(() => {
    // cssScale that maps each page's intrinsic width to THUMB_CSS_WIDTH (per-page, since widths can differ).
    return (i: number) => {
      const d = dims[i] ?? null;
      return d ? THUMB_CSS_WIDTH / d.width : 0;
    };
  }, [dims]);

  return (
    <div className="pdf-reader__thumbs" ref={railRef} onScroll={recompute} role="navigation" aria-label="Pages">
      <div className="pdf-reader__thumbs-track" style={{ height: layout.totalHeight || undefined }}>
        {Array.from({ length: opened.numPages }, (_, i) => {
          const pageNumber = i + 1;
          const scale = thumbScale(i);
          const isLive = railWindow.has(pageNumber) && scale > 0;
          const isActive = pageNumber === currentPage;
          return (
            <button
              type="button"
              key={pageNumber}
              className={'pdf-reader__thumb' + (isActive ? ' pdf-reader__thumb--active' : '')}
              data-thumb={pageNumber}
              aria-label={`Go to page ${pageNumber}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onJump(pageNumber)}
              style={{
                position: 'absolute',
                top: layout.offsets[i] ?? 0,
                width: THUMB_CSS_WIDTH,
                height: layout.heights[i] || undefined,
              }}
            >
              {isLive ? (
                <PdfThumbCanvas opened={opened} pageNumber={pageNumber} cssScale={scale} />
              ) : null}
              <span className="pdf-reader__thumb-num">{pageNumber}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One live thumbnail canvas — same mount-render / unmount-cancel-and-drop-bitmap lifecycle as the main page
 * canvas (§4.3 teardown), but submitted to the shared queue at LOW priority so it can't starve the reader.
 */
function PdfThumbCanvas({
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
    const handle = opened.renderPage(pageNumber, canvas, cssScale, { priority: RENDER_PRIORITY.THUMBNAIL });
    handle.promise.catch(() => {
      /* canceled or parse error for this thumb — the placeholder simply stays blank */
    });
    return () => {
      handle.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [opened, pageNumber, cssScale]);

  return <canvas ref={canvasRef} className="pdf-reader__thumb-canvas" />;
}

// Stable empty array so a page with no matches doesn't churn the text layer's memo deps.
const EMPTY_MATCHES: readonly PdfMatch[] = Object.freeze([]);

/**
 * The find bar (§3.4 / Slice 3): a query input, the `x of N` match counter, prev/next match navigation, and a
 * close button. Pure presentation — all index/jump logic lives in PdfReader; this just renders state + fires
 * callbacks. Enter / next advance; prev steps back. The input is auto-focused on open.
 */
function PdfSearchBar({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  indexing,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  matchCount: number;
  /** 0-based active match, or -1 when there are none. */
  activeIndex: number;
  indexing: boolean;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasQuery = query.trim() !== '';
  const counter =
    matchCount > 0
      ? `${activeIndex + 1} of ${matchCount}`
      : hasQuery
        ? indexing
          ? 'Indexing…'
          : 'No results'
        : '';

  return (
    <div className="pdf-reader__search" role="search">
      <input
        ref={inputRef}
        className="pdf-reader__search-input"
        type="text"
        aria-label="Search in document"
        placeholder="Find in document"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            onClose();
          }
        }}
      />
      <span className="pdf-reader__search-count" aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className="pdf-reader__search-step"
        aria-label="Previous match"
        onClick={onPrev}
        disabled={matchCount === 0}
      >
        ‹
      </button>
      <button
        type="button"
        className="pdf-reader__search-step"
        aria-label="Next match"
        onClick={onNext}
        disabled={matchCount === 0}
      >
        ›
      </button>
      <button type="button" className="pdf-reader__search-close" aria-label="Close search" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/**
 * The INERT text layer (§5.1, gate PDF-S) over one rendered page. It positions one plain `<span>` per extracted
 * text run at the run's glyph box, and within a span splits the text around search matches into `<mark>`s
 * (active match = a distinct class). This gives free native selection/copy AND the highlight surface.
 *
 * 🔒 ESCAPE-SAFETY — the exact mechanism that keeps attacker text inert: every piece of PDF text reaches the DOM
 * ONLY as a React child string (`{seg.text}` / `{item.str}`), i.e. a React text node → the browser sets it via
 * `textContent`, NEVER `innerHTML`. `splitItemForRender` only SLICES the string; it never builds markup. So a
 * run containing `<img onerror=…>` or `</span>` renders as those literal characters — no element is created, no
 * attribute is parsed, no script can run. There is NO `dangerouslySetInnerHTML` anywhere in this layer.
 */
function PdfTextLayer({
  pageText,
  cssScale,
  matches,
  activeMatch,
}: {
  pageText: PdfPageText;
  cssScale: number;
  matches: readonly PdfMatch[];
  activeMatch: PdfMatch | null;
}) {
  const items = pageText.items;
  const itemStarts = useMemo(() => pagePlainText(items).itemStarts, [items]);

  return (
    <div className="pdf-reader__textlayer">
      {items.map((item, i) => {
        const itemStart = itemStarts[i] ?? 0;
        const segs = splitItemForRender(item, itemStart, matches, activeMatch);
        const hasMark = segs.some((s) => s.kind !== 'plain');
        const fontSize = item.height * cssScale;
        return (
          <span
            key={i}
            className="pdf-reader__textspan"
            style={{
              left: item.left * cssScale,
              top: item.top * cssScale,
              fontSize: fontSize > 0 ? fontSize : undefined,
            }}
          >
            {!hasMark ? (
              // Fast path: no match in this run → the whole run as a single (escaped) React text node.
              item.str
            ) : (
              segs.map((seg, k) =>
                seg.kind === 'plain' ? (
                  // React text node — escaped. (Wrapped so keys are stable across segments.)
                  <span key={k}>{seg.text}</span>
                ) : (
                  <mark
                    key={k}
                    className={
                      'pdf-reader__hl' + (seg.kind === 'active' ? ' pdf-reader__hl--active' : '')
                    }
                  >
                    {seg.text}
                  </mark>
                ),
              )
            )}
          </span>
        );
      })}
    </div>
  );
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export default PdfReader;
