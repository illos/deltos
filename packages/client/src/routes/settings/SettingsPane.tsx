/**
 * SettingsPane — the shared chrome every settings tab body renders inside, forked by device variant.
 *
 * - desktop: a content-pane header (just the tab title, hairline underline) + a scrolling body. The
 *   nav is the tab rail (SettingsRail) in the middle pane, so the pane itself carries no back button.
 * - mobile: an iOS-pushed sub-screen — a "‹ {back}" back button + the section title, then the body.
 *   `onBack` runs the real router pop (or, for an Account sub-view, returns to the tab's list state).
 */
import type { ReactNode } from 'react';

export type SettingsVariant = 'desktop' | 'mobile';

interface SettingsPaneProps {
  variant: SettingsVariant;
  title: string;
  /** Mobile back affordance target. Omitted → no back button (shouldn't happen for a tab). */
  onBack?: () => void;
  /** Label after the "‹" chevron (e.g. "Settings" from a tab, "Account" from a sub-view). */
  backLabel?: string;
  children: ReactNode;
}

export function SettingsPane({ variant, title, onBack, backLabel = 'Settings', children }: SettingsPaneProps) {
  if (variant === 'desktop') {
    return (
      <div className="settings settings--desktop">
        <header className="settings__pane-header">
          <h1 className="settings__pane-title">{title}</h1>
        </header>
        <div className="settings__pane-body">{children}</div>
      </div>
    );
  }
  return (
    <div className="settings">
      <header className="settings__header">
        {onBack && (
          <button className="settings__back" onClick={onBack}>
            ‹ {backLabel}
          </button>
        )}
      </header>
      <h2 className="settings__title">{title}</h2>
      {children}
    </div>
  );
}
