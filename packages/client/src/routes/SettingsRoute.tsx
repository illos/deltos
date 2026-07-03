/**
 * SettingsRoute — the settings shell for /settings and /settings/:tab (authed shell only).
 *
 * Six tabs (Jim's binding deviation from the 7-tab handoff — Security is folded into Account):
 *   Account · Appearance · Connections · Activity · Editor · About.
 *
 * Layouts (settings-revamp handoff):
 *   - DESKTOP: the tab RAIL lives in the shell's middle pane (SettingsRail, mounted by
 *     ThreeRegionShell); this route renders only the active tab's body in the right pane. `/settings`
 *     redirects to `/settings/account`; an unknown tab redirects to account.
 *   - MOBILE: `/settings` is the grouped iOS-style LIST of the six rows; tapping a row navigates to
 *     `/settings/:tab` — a real router push into that section's sub-screen (back button/gesture work).
 *     An unknown tab redirects back to the list.
 *
 * The tab bodies (AccountTab holds the sign-out / recovery-phrase / 2FA `View` state machine intact)
 * live in ./settings/* and are re-homed verbatim from the old single-scroll route. This whole route
 * stays behind the App.tsx `lazy()` boundary, so the settings chunk never touches first load.
 */
import type { ComponentType } from 'react';
import { Navigate, useParams, useNavigate, Link } from 'react-router-dom';
import { useIsDesktop } from '../lib/useIsDesktop.js';
import { Chevron } from '../icons/index.js';
import { TABS, isTabId, type TabId } from './settings/tabs.js';
import type { SettingsVariant } from './settings/SettingsPane.js';
import { AccountTab } from './settings/AccountTab.js';
import { AppearanceTab } from './settings/AppearanceTab.js';
import { ConnectionsTab } from './settings/ConnectionsTab.js';
import { ActivityTab } from './settings/ActivityTab.js';
import { EditorTab } from './settings/EditorTab.js';
import { AboutTab } from './settings/AboutTab.js';

const TAB_BODIES: Record<TabId, ComponentType<{ variant: SettingsVariant }>> = {
  account: AccountTab,
  appearance: AppearanceTab,
  connections: ConnectionsTab,
  activity: ActivityTab,
  editor: EditorTab,
  about: AboutTab,
};

/** Mobile-only grouped list of the six tabs (the /settings landing on a phone). */
function SettingsList() {
  const navigate = useNavigate();
  return (
    <div className="settings">
      <header className="settings__header">
        <button className="settings__back" onClick={() => navigate('/')}>
          ‹ Notes
        </button>
      </header>
      <h1 className="settings__screen-title">Settings</h1>
      <nav className="settings__list" aria-label="Settings">
        {TABS.map(({ id, label, Icon }) => (
          <Link key={id} to={`/settings/${id}`} className="settings__list-row">
            <Icon className="settings__list-icon" size={20} />
            <span className="settings__list-label">{label}</span>
            <Chevron className="settings__list-chevron" size={16} />
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function SettingsRoute() {
  const isDesktop = useIsDesktop();
  const { tab } = useParams();

  if (isDesktop) {
    // Desktop: the rail is the nav (middle pane); this pane always shows a tab body. No tab / unknown
    // tab → land on Account.
    if (!isTabId(tab)) return <Navigate to="/settings/account" replace />;
    const Body = TAB_BODIES[tab];
    return <Body variant="desktop" />;
  }

  // Mobile: /settings is the grouped list; /settings/:tab is a pushed sub-screen.
  if (tab === undefined) return <SettingsList />;
  if (!isTabId(tab)) return <Navigate to="/settings" replace />;
  const Body = TAB_BODIES[tab];
  return <Body variant="mobile" />;
}
