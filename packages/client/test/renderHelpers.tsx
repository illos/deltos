/**
 * Shared render utilities for jsdom component tests.
 *
 * Test file naming convention: *.render.test.tsx
 * Vitest routes these to the jsdom environment automatically (vite.config.ts environmentMatchGlobs).
 *
 * Usage:
 *   import { renderWithProviders, screen, userEvent } from './renderHelpers.js';
 *
 *   it('renders the disclosure text', async () => {
 *     const user = userEvent.setup();
 *     renderWithProviders(<Disclosure usesPrf={false} />);
 *     expect(screen.getByText(/device-local/i)).toBeDefined();
 *   });
 *
 * What's provided:
 *   renderWithProviders — React 19 render wrapped in MemoryRouter (react-router-dom)
 *   screen              — @testing-library/react DOM queries
 *   userEvent           — @testing-library/user-event (async by default)
 *   waitFor             — @testing-library/react async utility
 *   within              — @testing-library/react scoped queries
 *
 * If a test needs a specific route (e.g. to test that Disclosure ONLY renders on /enroll),
 * pass initialEntries to renderWithProviders:
 *   renderWithProviders(<App />, { route: '/enroll' });
 *
 * Owners: secSys (harness author), gruntSys2 (P1-10 render + CAV-8 consumers).
 * Matrix rows unlocked: P1-10 render leg, CAV-8 (toast + badge).
 */

import React from 'react';
import { render as rtlRender } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RenderResult } from '@testing-library/react';

export { screen, waitFor, within } from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';

export interface RenderOptions {
  /** Initial route for MemoryRouter. Defaults to '/'. */
  route?: string;
}

/**
 * Render a React subtree inside a MemoryRouter.
 * Returns the full @testing-library/react result (container, rerender, unmount, etc.).
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderOptions = {},
): RenderResult {
  const { route = '/' } = options;
  return rtlRender(
    <MemoryRouter initialEntries={[route]}>
      {ui}
    </MemoryRouter>,
  );
}
