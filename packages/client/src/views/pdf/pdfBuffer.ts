/**
 * pdf.js TRANSFERS the input buffer to its parser web worker, which DETACHES that ArrayBuffer on the main
 * thread (its `byteLength` drops to 0). See pdf.js `getDocument` → `sendWithPromise("GetDocRequest", …, [data.buffer])`:
 * `data.buffer` is put in the worker postMessage transfer list, so it is moved (not copied) and detached here.
 *
 * Our content-addressed blob cache (`blobClient.bytesMem`) hands the SAME `ArrayBuffer` reference back on every
 * reopen. So if we transferred the cached buffer, the FIRST open would detach the cache entry, and the SECOND
 * open (a cache hit, especially on a mobile back-and-reopen) would receive a detached/empty buffer → pdf.js
 * throws `Cannot perform Construct on a detached ArrayBuffer` → the reader degrades to "Couldn't open this PDF".
 * This is the reopen-fails-on-second-visit bug.
 *
 * The fix: hand pdf.js a fresh, independent COPY of the bytes on every open (`slice(0)` copies the underlying
 * buffer). pdf.js may then transfer/detach THAT copy freely — the cached buffer is never the one transferred, so
 * it stays intact and every reopen succeeds. The per-open copy is cheap relative to parsing and keeps the blob
 * cache's zero-cost, account-scoped reopen guarantee fully intact.
 */
export function toWorkerData(data: ArrayBuffer): Uint8Array {
  // `data.slice(0)` is a fresh ArrayBuffer (an independent copy); the view over it is what pdf.js detaches.
  return new Uint8Array(data.slice(0));
}
