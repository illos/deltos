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

// Default v1 actions — registered at module init.
registerNavAction({ id: 'new-note', label: '＋ New note', ariaLabel: 'New note' });
registerNavAction({ id: 'search',   label: '🔍 Search',   ariaLabel: 'Search' });
