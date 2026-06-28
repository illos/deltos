/**
 * REOPEN-DETACHMENT regression (real pdf.js) — the second-visit "Couldn't open this PDF" bug.
 *
 * Root cause (proven here against the REAL pdfjs-dist parser, not a mock): pdf.js TRANSFERS the input buffer
 * into its parser worker (`getDocument` → `sendWithPromise("GetDocRequest", …, [data.buffer])`), which DETACHES
 * that ArrayBuffer on the main thread (`byteLength` → 0). Our blob cache (`bytesMem`) returns the SAME
 * ArrayBuffer on every reopen, so transferring the cached buffer detaches the cache entry and the NEXT open
 * (a cache hit — the back-and-reopen on mobile) receives a detached buffer → pdf.js throws.
 *
 * - "current" prep (`new Uint8Array(buffer)`, a full VIEW over the cached buffer) → first open DETACHES it,
 *   reopen on the same buffer THROWS. (Locks the bug so a regression can't silently return.)
 * - `toWorkerData(buffer)` (the fix — a `slice(0)` COPY) → cached buffer stays intact, reopen SUCCEEDS.
 *
 * Node has no real Worker, so pdf.js uses its in-process LoopbackPort — which still honors the postMessage
 * transfer list via `structuredClone(obj, { transfer })`, so the detachment is faithfully reproduced here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { toWorkerData } from '../src/views/pdf/pdfBuffer.js';

// pdf.js' main-thread (fake-worker) parse path touches a few browser globals + recent TC39 methods this Node
// build lacks. We exercise PARSE only (no rendering), so trivial shims suffice. Installed before pdfjs loads.
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  const P = Promise as unknown as { try?: unknown };
  if (!P.try) {
    P.try = (fn: (...a: unknown[]) => unknown, ...a: unknown[]) =>
      new Promise((resolve) => resolve(fn(...a)));
  }
  const u8 = Uint8Array.prototype as unknown as { toHex?: () => string };
  if (!u8.toHex) {
    u8.toHex = function (this: Uint8Array) {
      let s = '';
      for (const b of this) s += b.toString(16).padStart(2, '0');
      return s;
    };
  }
  const U8 = Uint8Array as unknown as { fromHex?: (h: string) => Uint8Array };
  if (!U8.fromHex) {
    U8.fromHex = (h: string) => {
      const a = new Uint8Array(h.length / 2);
      for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
      return a;
    };
  }
  if (typeof g.DOMMatrix === 'undefined') {
    g.DOMMatrix = class {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      scale() { return this; }
      translate() { return this; }
      multiply() { return this; }
      scaleSelf() { return this; }
    };
  }
});

// A minimal but VALID single-page PDF (Hello PDF). Built as a fresh standalone ArrayBuffer each call to stand in
// for a `bytesMem` cache entry.
const PDF_SRC = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  'endobj',
  '4 0 obj',
  '<< /Length 44 >>',
  'stream',
  'BT /F1 18 Tf 20 100 Td (Hello PDF) Tj ET',
  'endstream',
  'endobj',
  '5 0 obj',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  'endobj',
  'xref',
  '0 6',
  '0000000000 65535 f ',
  'trailer',
  '<< /Root 1 0 R /Size 6 >>',
  'startxref',
  '0',
  '%%EOF',
].join('\n');

function pdfBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(PDF_SRC.length);
  const u = new Uint8Array(buf);
  for (let i = 0; i < PDF_SRC.length; i++) u[i] = PDF_SRC.charCodeAt(i) & 0xff;
  return buf;
}

// The SAME security config openPdf uses on getDocument (minus the explicit worker — we let pdf.js use its
// in-process fake worker so the test needs no Worker/`?url` asset).
async function openWith(data: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  const task = pdfjs.getDocument({
    data,
    enableScripting: false,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
  });
  const doc = await task.promise;
  const n = doc.numPages;
  await task.destroy();
  return n;
}

describe('PDF reopen / ArrayBuffer-detachment (real pdf.js)', () => {
  it('the BUG: a full-view Uint8Array of the cached buffer is DETACHED by the first open, and a reopen throws', async () => {
    const cached = pdfBuffer();
    expect(cached.byteLength).toBeGreaterThan(0);

    // First open with a full VIEW over the cached buffer (what the old code did).
    expect(await openWith(new Uint8Array(cached))).toBe(1);

    // pdf.js transferred + detached the cached buffer.
    expect(cached.byteLength).toBe(0);

    // The reopen (a cache HIT returning the SAME, now-detached buffer) cannot even construct the worker view —
    // `new Uint8Array(detachedBuffer)` throws synchronously. THIS is the throw openPdf surfaced → "Couldn't open".
    expect(() => new Uint8Array(cached)).toThrow(/detached/i);
  });

  it('the FIX: toWorkerData keeps the cached buffer intact, so a reopen with the same buffer SUCCEEDS', async () => {
    const cached = pdfBuffer();

    // First open via the fix — pdf.js transfers/detaches the COPY, never the cached buffer.
    expect(await openWith(toWorkerData(cached))).toBe(1);

    // The cache entry survives — byteLength unchanged.
    expect(cached.byteLength).toBe(PDF_SRC.length);

    // Reopen on the SAME cached buffer (the second visit) now succeeds.
    expect(await openWith(toWorkerData(cached))).toBe(1);

    // And the buffer is STILL intact after the reopen → reopen is repeatable.
    expect(cached.byteLength).toBe(PDF_SRC.length);
  });
});
