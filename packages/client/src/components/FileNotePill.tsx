import { useEffect, useState } from 'react';
import type { Note } from '@deltos/shared';
import { resolveFileIcon } from '../icons/index.js';
import { fileNoteAttachment, formatFileSize } from '../plugins/attachment/attachmentBlock.js';

/**
 * The file-note artifact pill (file-notes.md §3.1) — the LIST-row content for a file note (replaces the
 * default title + preview row). More object-like than a line of prose: a leading visual + filename + a faint
 * size/type meta line. It renders INSIDE the existing `<Link>`/`<SwipeRow>` (App.tsx), so swipe-delete /
 * duplicate / move keep working on the Note unchanged.
 *
 * Perf (north-star, gate FN-8): the row stays cheap. The format icon paints synchronously; only an IMAGE
 * note fires a single session-cached thumbnail fetch, and the blob client is DYNAMIC-imported inside the
 * effect so it never ships in the entry bundle. A missing/unbaked thumbnail (404) degrades gracefully to the
 * format icon — never a broken image.
 */

// Raster image mimes/extensions we attempt a thumbnail tile for. A miss falls back to the format icon, so an
// over-broad guess is harmless (worst case: one 404 then the icon). mime may be '' for some dropped files →
// fall back to the filename extension.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif']);
function isThumbnailableImage(mime: string, name: string): boolean {
  if (IMAGE_MIMES.has(mime)) return true;
  return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name);
}

/** Leading visual: a square WebP thumbnail tile for images (async, icon fallback on miss), else the format icon. */
function FileNoteLeading({ hash, name, mime }: { hash: string; name: string; mime: string }) {
  const image = isThumbnailableImage(mime, name);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!image) return;
    let alive = true;
    void import('../plugins/attachment/blobClient.js')
      .then(({ loadThumbUrl }) => loadThumbUrl(hash))
      .then((u) => { if (alive) setThumb(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [hash, image]);

  if (image && thumb && !failed) {
    return <img className="home__pill-thumb" src={thumb} alt="" loading="lazy" decoding="async" />;
  }
  const Icon = resolveFileIcon(name, mime);
  return (
    <span className="home__pill-icon" aria-hidden="true">
      <Icon size={22} />
    </span>
  );
}

export function FileNotePill({ note }: { note: Note }) {
  const att = fileNoteAttachment(note);
  const name = att?.name || note.title || 'File';
  const mime = att?.mime ?? '';
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const meta = [ext, att && att.size > 0 ? formatFileSize(att.size) : null].filter(Boolean).join(' · ');

  return (
    <span className="home__pill">
      {att ? (
        <FileNoteLeading hash={att.hash} name={name} mime={mime} />
      ) : (
        <span className="home__pill-icon" aria-hidden="true">
          {/* No well-formed attachment block — degrade to the generic glyph rather than fetch. */}
          {(() => { const Icon = resolveFileIcon(name, mime); return <Icon size={22} />; })()}
        </span>
      )}
      <span className="home__pill-body">
        <span className="home__note-title">{name}</span>
        {meta && <span className="home__pill-meta">{meta}</span>}
      </span>
    </span>
  );
}
