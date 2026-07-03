/**
 * SettingsRail — the desktop settings navigation, rendered by ThreeRegionShell in the MIDDLE pane
 * (the list-pane slot) while on a /settings route, replacing the notes list. Header: a "‹ Notes"
 * back button + the "Settings" title; below, the six tab rows (icon + label), the active row
 * highlighted via NavLink.
 *
 * Deliberately lightweight — imports only icons + react-router, NOT the heavy tab bodies — so it can
 * ride the (statically-loaded) desktop shell without dragging the settings chunk onto first load.
 */
import { NavLink, useNavigate } from 'react-router-dom';
import { Chevron } from '../../icons/index.js';
import { TABS } from './tabs.js';

export function SettingsRail() {
  const navigate = useNavigate();
  return (
    <nav className="settings-rail" aria-label="Settings">
      <div className="settings-rail__header">
        <button className="settings-rail__back" onClick={() => navigate('/')}>
          <Chevron size={14} />
          <span>Notes</span>
        </button>
        <h2 className="settings-rail__title">Settings</h2>
      </div>
      <div className="settings-rail__tabs">
        {TABS.map(({ id, label, Icon }) => (
          <NavLink
            key={id}
            to={`/settings/${id}`}
            className={({ isActive }) =>
              `settings-rail__tab${isActive ? ' settings-rail__tab--active' : ''}`
            }
          >
            <Icon className="settings-rail__tab-icon" size={18} />
            <span className="settings-rail__tab-label">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
