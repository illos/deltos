/**
 * Attachment plugin TIER-2 runtime (A4 #126) — the LAZY half, dynamic-imported on demand (the first async
 * plugin runtime; it exercises A1's two-tier load path). Pulls react-dom + the blob client, so it must stay
 * out of the eager/entry graph — the manifest references it via `import()`, never a static import.
 */
import type { PluginRuntime } from '../runtime/manifest.js';
import { attachmentIslandFactory } from './AttachmentNodeView.js';

export const attachmentRuntime: PluginRuntime = {
  islandFactories: {
    attachment: attachmentIslandFactory,
  },
};
