import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { NotebookId } from '@deltos/shared';

/**
 * BOTH-SHELLS trap guard (alert-banner-system.md §5.1) — the known failure mode where a host added to one
 * shell is silently missing from the other. This mounts the REAL AuthedShell in BOTH device branches (mobile:
 * isDesktop=false → single-column shell with the strip after the header; desktop: isDesktop=true → the strip
 * wrapping ThreeRegionShell) and asserts the AlertBanner strip renders in EACH when the store holds an alert.
 * Both mounts share ONE file (App.tsx), so this pins that the mount exists in both device branches at once.
 *
 * The banner is driven by the REAL alertStore; its REST client + the heavy ThreeRegionShell subtree are
 * stubbed so the shells mount light without touching what we assert on (the `.alert-banner` strip).
 */

const isDesktop = { current: false };
vi.mock('./lib/useIsDesktop.js', () => ({ useIsDesktop: () => isDesktop.current }));
vi.mock('./lib/useTouchPrimary.js', () => ({ useTouchPrimary: () => false }));
vi.mock('./lib/useKeypadMode.js', () => ({ useKeypadMode: () => false }));
vi.mock('./lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('./lib/dnd/useFileNoteDnd.js', () => ({ useFileNoteDnd: () => null }));

vi.mock('./lib/syncEngine.js', () => ({
  startSyncTriggers: () => () => {},
  syncNow: () => {},
  notifyQueueWrite: vi.fn(),
}));
vi.mock('./auth/store.js', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ sessionState: 'active' }),
}));

const nbState = { current: { _ready: true, currentNotebookId: null as NotebookId | null, init: async () => {} } };
vi.mock('./lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) => sel(nbState.current),
}));
vi.mock('./db/storeHooks.js', () => ({
  useNotes: () => [],
  useNotebooks: () => [],
  useCurrentNotebook: () => null,
}));

// Chrome + heavy shells stubbed to trivial nodes — the AlertBanner under test is REAL. In particular the
// desktop 3-region shell is stubbed so the desktop branch mounts without NavContent/editor deps; the banner
// wraps it in App.tsx, so the strip still renders around the stub.
vi.mock('./components/ThreeRegionShell.js', () => ({ ThreeRegionShell: () => <div data-region-shell /> }));
vi.mock('./components/DrawerNav.js', () => ({ DrawerNav: () => null }));
vi.mock('./components/ContextMenuSheet.js', () => ({ ContextMenuSheet: () => null }));
vi.mock('./components/BottomNav.js', () => ({ BottomNav: () => null }));
vi.mock('./components/SessionStatus.js', () => ({ SessionStatus: () => null }));
vi.mock('./components/SyncIndicator.js', () => ({ SyncIndicator: () => null }));
vi.mock('./components/ConflictToastHostSlot.js', () => ({ ConflictToastHostSlot: () => null }));
vi.mock('./components/UploadProgressHost.js', () => ({ UploadProgressHost: () => null }));
vi.mock('./components/ConflictBadgeSlot.js', () => ({ ConflictBadgeSlot: () => null }));
vi.mock('./components/Lightbox.js', () => ({ Lightbox: () => null }));
// The banner's REST client is stubbed (no network); AlertBanner + alertStore stay REAL.
vi.mock('./lib/alertsClient.js', () => ({ actOnAlert: vi.fn(), AlertActionError: class extends Error {} }));
vi.mock('./components/DeckHost.js', () => ({
  DeckHostProvider: ({ children }: { children: ReactNode }) => children,
  useDeckHost: () => ({ publishEditor: () => {} }),
  DECK_SEARCH_CONTEXT: 'search',
}));
vi.mock('./components/NavSheet.js', () => ({
  NavSheetProvider: ({ children }: { children: ReactNode }) => children,
  NavSheet: () => null,
}));

// Imported AFTER the mocks (vi.mock is hoisted).
import { AuthedShell } from './App.js';
import { setServerAlerts, __resetAlertStore } from './lib/alertStore.js';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthedShell />
    </MemoryRouter>,
  );
}

function pushAlert() {
  act(() => {
    setServerAlerts([{
      id: 'ap-1', kind: 'agent.writeApproval', severity: 'warning', source: 'server',
      title: 'Approval needed', message: 'An agent wants more write headroom',
      createdAt: 1000, dismissible: true, expiresAt: null,
      actions: [{ id: 'approve', label: 'Approve', style: 'primary' }],
      targetKind: 'writeApproval', targetId: 'wa-1',
    }]);
  });
}

beforeEach(() => { __resetAlertStore(); nbState.current = { _ready: true, currentNotebookId: null, init: async () => {} }; });
afterEach(cleanup);

describe('AlertBanner both-shells mount', () => {
  it('renders the alert strip in the MOBILE shell (single-column, after the header)', () => {
    isDesktop.current = false;
    const { container } = mount();
    expect(container.querySelector('.shell')).not.toBeNull();      // confirm we ARE in the mobile shell
    expect(container.querySelector('.alert-banner')).toBeNull();   // null-render when empty
    pushAlert();
    expect(container.querySelector('.alert-banner')).not.toBeNull();
  });

  it('renders the alert strip in the DESKTOP shell (wrapping ThreeRegionShell)', () => {
    isDesktop.current = true;
    const { container } = mount();
    expect(container.querySelector('[data-region-shell]')).not.toBeNull(); // confirm the desktop branch
    expect(container.querySelector('.alert-banner')).toBeNull();
    pushAlert();
    expect(container.querySelector('.alert-banner')).not.toBeNull();
  });
});
