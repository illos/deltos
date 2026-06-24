/**
 * Render-context (docs/specs/plugin-support.md §4/§5) — the situation a block is being rendered in. Passed
 * to a block's render-only component so it can pick a DEGRADED form (the degradation logic is A3 #125; A2
 * just defines + plumbs the context). PM-free leaf so both the read-only path and A3 import it without
 * pulling prosemirror-view.
 *
 *  - live-edit          — inside the editor, interactive (the NodeView path; not this component).
 *  - read-only-preview  — read-only, in-app (search peek, list preview, history diff).
 *  - offline            — no network — an online-only block shows its cached/degraded form.
 *  - shared             — a public/shared-URL render (no auth, no app shell).
 */
export type PluginRenderContext = 'live-edit' | 'read-only-preview' | 'offline' | 'shared';

import type { ReactNode } from 'react';

/**
 * A block's PURE render-only component (§5 fork b): spine payload + context → display, NO ProseMirror. The
 * in-editor NodeView wraps the shared presentation separately; read-only paths use this directly.
 */
export type PluginRenderOnlyComponent = (props: {
  payload: unknown;
  context: PluginRenderContext;
}) => ReactNode;

import type { PluginCapability } from './manifest.js';

/**
 * Render DEGRADATION policy (§4, A3 #125, secSys #679). A block with a network-bound capability shows a
 * degraded (cached / plain) form when the render context can't reach the network.
 *
 * ⛔ This governs PRESENTATION ONLY — it must NEVER gate access or branch a network REQUEST. Access stays
 * server-side ('online-only → degraded render', NOT 'online-only → client allow/deny fetch'). A render-only
 * component calls this to pick WHICH form to draw; it does not (and the read path cannot) make a fetch.
 *
 * Today: an `online-only` block degrades when offline. `offline`-capable blocks never degrade; other
 * capabilities are presentation-neutral here (their host enforcement is server-side, elsewhere).
 */
export function shouldDegrade(capability: PluginCapability, context: PluginRenderContext): boolean {
  return capability === 'online-only' && context === 'offline';
}

/** Derive the read context from app state (for future read-only surfaces). PM-free, presentation-only. */
export function deriveReadContext(opts: { online: boolean; shared?: boolean }): PluginRenderContext {
  if (opts.shared) return 'shared';
  return opts.online ? 'read-only-preview' : 'offline';
}
