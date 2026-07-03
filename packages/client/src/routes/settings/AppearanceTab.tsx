/**
 * AppearanceTab — the live theme switcher (AppearanceSection as-is, wrapped in the tab chrome).
 */
import { useNavigate } from 'react-router-dom';
import { AppearanceSection } from '../../components/AppearanceSection.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

export function AppearanceTab({ variant }: { variant: SettingsVariant }) {
  const navigate = useNavigate();
  return (
    <SettingsPane variant={variant} title="Appearance" onBack={() => navigate('/settings')}>
      <AppearanceSection />
    </SettingsPane>
  );
}
