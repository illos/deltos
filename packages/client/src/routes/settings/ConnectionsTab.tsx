/**
 * ConnectionsTab — the Claude/MCP connection surfaces: manual paste-token (ConnectClaude), one-click
 * OAuth grants (ConnectedApps), and the agent's note-routing guide.
 */
import { useNavigate } from 'react-router-dom';
import { ConnectClaudeSection } from '../../components/ConnectClaudeSection.js';
import { ConnectedAppsSection } from '../../components/ConnectedAppsSection.js';
import { RoutingGuideSection } from '../../components/RoutingGuideSection.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

export function ConnectionsTab({ variant }: { variant: SettingsVariant }) {
  const navigate = useNavigate();
  return (
    <SettingsPane variant={variant} title="Connections" onBack={() => navigate('/settings')}>
      <ConnectClaudeSection />
      <ConnectedAppsSection />
      <RoutingGuideSection />
    </SettingsPane>
  );
}
