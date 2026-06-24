import './embeds.css';

export interface LinkCardBodyProps {
  url: string;
  // explicit `| undefined` (exactOptionalPropertyTypes): callers pass payload fields that may be undefined.
  title?: string | undefined;
  favicon?: string | undefined;
  loading?: boolean | undefined;
  error?: boolean | undefined;
}

export interface LinkCardProps extends LinkCardBodyProps {
  siteName?: string;
  onOpen: () => void;
  onDowngrade: () => void;
}

/**
 * The shared link-card PRESENTATION (§5: "ships its presentation once"). Zero ProseMirror, zero interaction
 * — just favicon + title + url. Both surfaces wrap it: the in-editor NodeView (interactive, below) and the
 * read-only view (LinkCardRenderOnly), so the look is defined in one place.
 */
export function LinkCardBody({ url, title, favicon, loading, error }: LinkCardBodyProps) {
  const displayTitle = title ?? (loading ? null : url);
  const showFavicon = !loading && !error && favicon;
  return (
    <>
      {showFavicon ? (
        <img
          className="link-card__favicon"
          src={favicon}
          alt=""
          aria-hidden="true"
          width={20}
          height={20}
          // secSys: no Referer to the favicon host — don't leak the deltos URL / note context off-origin.
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="link-card__favicon-placeholder" aria-hidden="true" />
      )}
      <span className="link-card__body">
        {loading && !displayTitle ? (
          <span className="link-card__title--placeholder" aria-hidden="true" />
        ) : (
          <span className="link-card__title">{displayTitle}</span>
        )}
        <span className="link-card__url">{url}</span>
      </span>
    </>
  );
}

/** Presentational link-card (§5 E2a) — the INTERACTIVE (in-editor) surface. Zero ProseMirror; driven by
 *  props. The PM NodeView (E2b, devSys-2) mounts this and supplies props + callbacks. */
export function LinkCard({ url, title, favicon, loading, error, onOpen, onDowngrade }: LinkCardProps) {
  return (
    <div
      className="link-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={title ? `Open link: ${title}` : `Open link: ${url}`}
    >
      <LinkCardBody url={url} title={title} favicon={favicon} loading={loading} error={error} />
      <button
        className="link-card__downgrade"
        onClick={(e) => { e.stopPropagation(); onDowngrade(); }}
        aria-label="Remove card — downgrade to plain link"
        tabIndex={0}
      >
        ×
      </button>
    </div>
  );
}
