import './embeds.css';

export interface LinkCardProps {
  url: string;
  title?: string;
  favicon?: string;
  siteName?: string;
  loading?: boolean;
  error?: boolean;
  onOpen: () => void;
  onDowngrade: () => void;
}

/** Presentational link-card (§5 E2a). Zero ProseMirror — driven entirely by props.
 *  The PM NodeView (E2b, devSys-2) mounts this and supplies props + callbacks. */
export function LinkCard({ url, title, favicon, loading, error, onOpen, onDowngrade }: LinkCardProps) {
  const displayTitle = title ?? (loading ? null : url);
  const showFavicon = !loading && !error && favicon;

  return (
    <div
      className="link-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={title ? `Open link: ${title}` : `Open link: ${url}`}
    >
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
