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
