import { LinkCardBody } from './LinkCard.js';
import { shouldDegrade, type PluginRenderContext } from '../runtime/renderContext.js';

interface LinkCardPayload {
  url?: string;
  title?: string;
  favicon?: string;
  siteName?: string;
  loading?: boolean;
  error?: boolean;
}

// link_card is an `online-only` capability (unfurl is a network fetch). The render-only path NEVER fetches,
// so its only job is to never show a broken/forever-loading card when the metadata can't have arrived.
const CAPABILITY = 'online-only' as const;

/**
 * The link_card RENDER-ONLY view (§5 fork b, A2 #124; degraded render A3 #125) — the read-only surface used
 * OUTSIDE an editor (search peek, list preview, history diff, share). Zero ProseMirror, and it makes NO
 * network request — context-driven degradation is PRESENTATION ONLY (secSys #679), never access-gating.
 *
 * Degraded form: an online-only card that is offline AND has no cached metadata (just a url / still
 * "loading") would otherwise render an empty/placeholder card → instead show a plain, legible link (never
 * broken). With cached metadata the full card renders fine offline — it's all in the payload.
 */
export function LinkCardRenderOnly({ payload, context }: { payload: unknown; context: PluginRenderContext }) {
  const c = (payload ?? {}) as LinkCardPayload;
  const url = c.url ?? '';
  const hasCachedMeta = !!(c.title || c.favicon);

  if (shouldDegrade(CAPABILITY, context) && !hasCachedMeta) {
    return (
      <a
        className="link-card--degraded"
        href={url || undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
        aria-label={`Open link: ${url}`}
      >
        {c.title ?? url}
      </a>
    );
  }

  return (
    <a
      className="link-card link-card--readonly"
      href={url || undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      // secSys: no Referer off-origin — don't leak the deltos note URL to the link host.
      referrerPolicy="no-referrer"
      aria-label={c.title ? `Open link: ${c.title}` : `Open link: ${url}`}
    >
      <LinkCardBody url={url} title={c.title} favicon={c.favicon} loading={c.loading} error={c.error} />
    </a>
  );
}
