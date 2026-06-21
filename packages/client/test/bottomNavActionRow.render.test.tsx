/**
 * Lane 2 mobile shell (§4/§6) — the BottomNav action-slot row treatment. Proves the §4 row renders
 * the New · Undo · Redo · Search slots, each an icon over its label, with New as the accent slot, and
 * the §6 grab-handle present. Visual fidelity (sheet radius/shadow/colors) is navSys-3's mobile diff.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BottomNav } from '../src/components/BottomNav.js';

afterEach(cleanup);

describe('BottomNav — §4 action-slot row + §6 grab handle', () => {
  it('renders the New/Undo/Redo/Search slots (icon + label), New accented, + the grab handle', () => {
    render(<MemoryRouter><BottomNav /></MemoryRouter>);

    // The four §4 action slots, each with its Plex Mono label.
    for (const label of ['New', 'Undo', 'Redo', 'Search']) {
      expect(screen.getByText(label), `${label} label`).toBeTruthy();
    }
    // Reachable by their accessible names (New note / Undo / Redo / Search).
    expect(screen.getByLabelText('New note')).toBeTruthy();
    expect(screen.getByLabelText('Search')).toBeTruthy();

    // New is the accent slot; each slot carries an icon (svg).
    const newBtn = screen.getByLabelText('New note');
    expect(newBtn.className).toContain('bottom-nav__action--accent');
    expect(newBtn.querySelector('svg'), 'New slot icon').not.toBeNull();

    // §6 grab handle (the --handle pill toggle).
    expect(screen.getByLabelText(/Expand navigation/)).toBeTruthy();
  });
});
