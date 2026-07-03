/**
 * Settings tab registry — the single source of truth for the six-tab shell (order, ids, labels,
 * icons). Consumed by the desktop tab rail (SettingsRail), the mobile grouped list (SettingsRoute),
 * and the router (valid-tab guard). Six tabs, per Jim's binding deviation from the 7-tab handoff:
 * Security is folded into Account.
 */
import type { ComponentType } from 'react';
import type { IconProps } from '../../icons/index.js';
import { User, Sun, Link as LinkIcon, Activity, SettingsSliders, Info } from '../../icons/index.js';

export type TabId = 'account' | 'appearance' | 'connections' | 'activity' | 'editor' | 'about';

export interface TabDef {
  id: TabId;
  label: string;
  Icon: ComponentType<IconProps>;
}

export const TABS: readonly TabDef[] = [
  { id: 'account', label: 'Account', Icon: User },
  { id: 'appearance', label: 'Appearance', Icon: Sun },
  { id: 'connections', label: 'Connections', Icon: LinkIcon },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'editor', label: 'Editor', Icon: SettingsSliders },
  { id: 'about', label: 'About', Icon: Info },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

export function isTabId(v: string | undefined): v is TabId {
  return v != null && TAB_IDS.has(v);
}

export function tabLabel(id: TabId): string {
  return TABS.find((t) => t.id === id)?.label ?? 'Settings';
}
