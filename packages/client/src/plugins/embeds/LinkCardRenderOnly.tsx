import { LinkCardBody } from './LinkCard.js';
import type { PluginRenderContext } from '../runtime/renderContext.js';

interface LinkCardPayload {
  url?: string;
  title?: string;
  favicon?: string;
  siteName?: string;
  loading?: boolean;
  error?: boolean;
}

/**
 * The link_card RENDER-ONLY view (§5 fork b, A2 #124) — the read-only surface used OUTSIDE an editor (search
 * peek, list preview, history diff, share). Zero ProseMirror: a real anchor wrapping the shared
 * LinkCardBody, no downgrade affordance. Context-driven degradation (e.g. a degraded form when offline/
 * shared) is A3 #125 — A2 receives the context but renders the same card for every read-only context.
 */
export function LinkCardRenderOnly({ payload }: { payload: unknown; context: PluginRenderContext }) {
  const c = (payload ?? {}) as LinkCardPayload;
  const url = c.url ?? '';
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
