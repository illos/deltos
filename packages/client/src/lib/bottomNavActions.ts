/**
 * Extensible action-slot registry for the bottom nav bar.
 *
 * Actions are data-only descriptors (no handlers) — the BottomNav component resolves
 * the actual onClick by action.id so that hook-based logic (navigate, etc.) stays
 * in React component scope. New actions register their descriptor here; BottomNav's
 * `onAction` prop maps IDs to real handlers.
 *
 * Register at module load time. Ship: 'new-note' + 'search'. Future tooling/plugins
 * push additional descriptors without touching BottomNav itself.
 */

export interface BottomNavAction {
  id: string;
  label: string;
  ariaLabel: string;
}

const _registry: BottomNavAction[] = [];

/** Register an action slot. Returns a deregister function (useful in tests). */
export function registerNavAction(action: BottomNavAction): () => void {
  _registry.push(action);
  return () => {
    const i = _registry.indexOf(action);
    if (i >= 0) _registry.splice(i, 1);
  };
}

export function getNavActions(): readonly BottomNavAction[] {
  return _registry;
}

export function _clearNavRegistryForTest(): void {
  _registry.length = 0;
}

// Default actions — registered at module init. Packet §4 mobile action-slot row: New · Undo · Redo
// · Search (icon over a Plex Mono 10px label). The label is now plain text — BottomNav renders the
// icon mapped by id; future tooling/plugins push more descriptors without touching BottomNav.
registerNavAction({ id: 'new-note', label: 'New',    ariaLabel: 'New note' });
registerNavAction({ id: 'undo',     label: 'Undo',   ariaLabel: 'Undo' });
registerNavAction({ id: 'redo',     label: 'Redo',   ariaLabel: 'Redo' });
registerNavAction({ id: 'search',   label: 'Search', ariaLabel: 'Search' });
