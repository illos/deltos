import { AttachmentChip } from './AttachmentChip.js';
import type { PluginRenderContext } from '../runtime/renderContext.js';

interface AttachmentPayload {
  hash?: string;
  name?: string;
  mime?: string;
  size?: number;
}

/**
 * The attachment RENDER-ONLY view (§5 fork b, A2; A4 #126) — used OUTSIDE an editor (search peek, list
 * preview, share). FETCH-FREE BY DESIGN: it renders a lightweight chip (icon + name + size), never loading
 * the blob bytes — read-only previews stay light, and the read path makes no network access (secSys #679).
 * Inline image preview is the EDIT path's job. `blob` is offline-capable, so this chip renders identically
 * offline (all metadata is in the payload — no degraded branch needed).
 */
export function AttachmentRenderOnly({ payload }: { payload: unknown; context: PluginRenderContext }) {
  const c = (payload ?? {}) as AttachmentPayload;
  return <AttachmentChip name={c.name} mime={c.mime} size={c.size} />;
}
