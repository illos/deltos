/**
 * ActivityTab — the account-activity trust feed plus the active-sessions kill-switch. "Sign out
 * everywhere else" lives with the sessions list (inside SessionsSection).
 */
import { useNavigate } from 'react-router-dom';
import { ActivitySection } from '../../components/ActivitySection.js';
import { SessionsSection } from '../../components/SessionsSection.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

export function ActivityTab({ variant }: { variant: SettingsVariant }) {
  const navigate = useNavigate();
  return (
    <SettingsPane variant={variant} title="Activity" onBack={() => navigate('/settings')}>
      <ActivitySection />
      <SessionsSection />
    </SettingsPane>
  );
}
