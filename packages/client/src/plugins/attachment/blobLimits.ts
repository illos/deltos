/**
 * Blob upload size routing (direct-r2-upload.md §2.2). The ONE place the file-note size router's threshold
 * lives, so it can be shared by the router (`db/mutate.ts createFileNote`) and the direct-upload helper
 * (`blobClient.ts`) without either pulling the other in.
 *
 * This is a constant-only module (just a number) — safe to import from the core/entry bundle (`mutate.ts`)
 * WITHOUT dragging the heavy `blobClient` direct-upload code along with it. That is what keeps the perf split
 * (FN-8 / [[plugins-lazy-past-first-paint]]) intact: the threshold rides in the entry bundle; the hashing +
 * XHR PUT code stays lazy.
 *
 * COUPLING (HARD): this MUST equal the Worker's `MAX_BLOB_SIZE` (routes/blob.ts) — a file at exactly the
 * threshold takes the BUFFERED path (`uploadBlob` → POST /api/plugin/blob, which the Worker caps at
 * MAX_BLOB_SIZE); the first byte OVER routes to the DIRECT path (`uploadBlobDirect` → presign/PUT/confirm).
 * If one moves the other must move with it (the presign endpoint rejects `size <= MAX_BLOB_SIZE` as a client
 * routing bug), so keep the two numbers in lockstep.
 */
export const DIRECT_R2_THRESHOLD = 25 * 1024 * 1024;
