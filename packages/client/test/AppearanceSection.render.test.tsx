/**
 * Lane 5 — Appearance picker render gate (rendered-UI gate per ui-features-need-rendered-ui-gate).
 * Proves the picker renders all 11 chips, that tapping a chip flips the live theme-root attr AND
 * persists to device-local IDB, and that exactly one chip per group reflects the active store value.
 *
 * Voice assertions use Mono (FONT_CHUNK.mono = null) so no dynamic CSS import() is triggered in jsdom.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { screen, within } from '@testing-library/react';
import { db } from '../src/db/schema.js';
import { readTheme, DEFAULT_THEME } from '../src/db/themePointer.js';
import { useThemeStore } from '../src/lib/themeStore.js';
import { AppearanceSection } from '../src/components/AppearanceSection.js';

const html = () => document.documentElement;

beforeEach(async () => {
  await db.deviceState.clear();
  useThemeStore.setState({ ...DEFAULT_THEME, _ready: false });
  delete html().dataset.palette;
  delete html().dataset.voice;
  delete html().dataset.mode;
  await useThemeStore.getState().init(); // boots Ember × Sans × system, applies the root attrs
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AppearanceSection — renders the routed picker', () => {
  it('renders the Appearance section with all 4 palette + 4 voice + 3 mode chips', () => {
    render(<AppearanceSection />);
    expect(screen.getByRole('region', { name: 'Appearance' })).toBeTruthy();

    for (const label of ['Bone', 'Graphite', 'Manila', 'Ember']) {
      expect(screen.getByRole('radio', { name: label }), `palette ${label}`).toBeTruthy();
    }
    for (const label of ['Serif', 'Sans', 'Mono', 'Grotesk']) {
      expect(screen.getByRole('radio', { name: label }), `voice ${label}`).toBeTruthy();
    }
    for (const label of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('radio', { name: label }), `mode ${label}`).toBeTruthy();
    }
  });
});

describe('AppearanceSection — selecting a chip flips the theme root + persists', () => {
  it('palette: tapping Graphite sets data-palette + writes device-local IDB', async () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }));
    await waitFor(() => expect(html().dataset.palette).toBe('graphite'));
    expect((await readTheme()).palette).toBe('graphite');
  });

  it('voice: tapping Mono sets data-voice + persists (no lazy import)', async () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mono' }));
    await waitFor(() => expect(html().dataset.voice).toBe('mono'));
    expect((await readTheme()).voice).toBe('mono');
  });

  it('mode: tapping Dark then System flips data-mode each time + persists', async () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(html().dataset.mode).toBe('dark'));
    expect((await readTheme()).mode).toBe('dark');

    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    await waitFor(() => expect(html().dataset.mode).toBe('system'));
    expect((await readTheme()).mode).toBe('system');
  });
});

describe('AppearanceSection — active state reflects the store', () => {
  it('exactly one chip per group is active (is-active + aria-checked), tracking the value', async () => {
    const { container } = render(<AppearanceSection />);

    // Default boot = Graphite / Sans / Light → those three chips are the active ones.
    for (const [group, active] of [['Palette', 'Graphite'], ['Type voice', 'Sans'], ['Mode', 'Light']] as const) {
      const grp = screen.getByRole('radiogroup', { name: group });
      const checked = within(grp).getAllByRole('radio').filter((b) => b.getAttribute('aria-checked') === 'true');
      expect(checked.length, `${group} active count`).toBe(1);
      expect(checked[0].textContent).toContain(active);
      expect(checked[0].className).toContain('is-active');
    }

    // Flip palette → active follows. setPalette is async (fire-and-forget onClick), so wait for MANILA
    // specifically to become active — NOT just "one swatch active", which the pre-click Ember default
    // already satisfies (that raced: the wait returned before the re-render and Manila read false).
    fireEvent.click(screen.getByRole('radio', { name: 'Manila' }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Manila' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(container.querySelectorAll('.appearance__card--palette.is-active').length).toBe(1);
    expect(screen.getByRole('radio', { name: 'Ember' }).getAttribute('aria-checked')).toBe('false');
  });
});
