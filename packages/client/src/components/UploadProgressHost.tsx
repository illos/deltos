/**
 * UploadProgressHost — the UPLOAD-FIRST progress affordance for large file-note uploads (direct-r2-upload.md
 * §6.3). Renders one transient "uploading… NN%" pill per in-flight direct-to-R2 upload: filename · progress
 * bar (%) · Cancel. Mounted once at the shell level (like ToastHost) so it persists across navigation while a
 * big file streams.
 *
 * UPLOAD-FIRST: a row is NOT a note — the real file note is minted only on `confirm` success (createFileNote).
 * So a failed/cancelled upload just removes its row (the indicator disappears); there is never an orphan note.
 * Cancel calls the entry's stored `cancel()` (aborts the XHR). Small buffered uploads never register here.
 *
 * Lightweight (subscribes to a zustand store, no heavy imports) → entry-bundle-safe; the hashing/XHR code it
 * visualizes stays in the lazy blobClient chunk (FN-8 perf split).
 */
import { useUploadStore } from '../lib/uploadStore.js';

export function UploadProgressHost() {
  const uploads = useUploadStore((s) => s.uploads);
  if (uploads.length === 0) return null;

  return (
    <div className="upload-host" aria-live="polite" aria-atomic="false">
      {uploads.map((u) => {
        const pct = Math.round(u.progress * 100);
        return (
          <div key={u.id} className="upload-card" role="status">
            <div className="upload-card__row">
              <span className="upload-card__name" title={u.name}>{u.name}</span>
              <span className="upload-card__pct">{pct}%</span>
              <button
                className="upload-card__cancel"
                aria-label={`Cancel uploading ${u.name}`}
                onClick={() => u.cancel()}
              >
                Cancel
              </button>
            </div>
            <div
              className="upload-card__bar"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="upload-card__fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
