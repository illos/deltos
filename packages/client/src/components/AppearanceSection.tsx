import type { ReactNode } from 'react';
import { useThemeStore } from '../lib/themeStore.js';
import { PALETTES, VOICES, MODES, type Palette, type Voice, type Mode } from '../db/themePointer.js';

// Human labels + per-axis presentation metadata. Kept here (display concern), not in the store.
const PALETTE_LABEL: Record<Palette, string> = {
  bone: 'Bone', graphite: 'Graphite', manila: 'Manila', ember: 'Ember',
};
// Each voice label is rendered IN its own font via an inline fontFamily, so the pill is a live type
// specimen. We hard-name the family here (the pill overrides the family locally) so the specimen is
// correct even before that voice's lazy woff2 has loaded (falls back to the family's system fallback).
// The per-voice fontSize matches the prototype (optically balances the four typefaces at one pill size).
const VOICE_LABEL: Record<Voice, { name: string; family: string; size: number }> = {
  serif:   { name: 'Serif',   family: "'Newsreader', Georgia, serif",           size: 15 },
  sans:    { name: 'Sans',    family: "'IBM Plex Sans', system-ui, sans-serif",  size: 14 },
  mono:    { name: 'Mono',    family: "'IBM Plex Mono', ui-monospace, monospace", size: 13 },
  grotesk: { name: 'Grotesk', family: "'Space Grotesk', system-ui, sans-serif", size: 14 },
};
const MODE_LABEL: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

// Mode previews are THEME-AGNOSTIC — always real light vs. dark, never the active palette. Hexes are
// hardcoded literals per the handoff (like the palette-preview map in styles.css): these are pictures of
// light/dark, not the live theme. Each returns the inner screen for a 98×58 card window.
function modeScreen(m: Mode): ReactNode {
  if (m === 'light') {
    return (
      <span className="appearance__screen appearance__screen--light" aria-hidden>
        <span className="appearance__scr-bar" style={{ top: 11, left: 11, width: '44%', height: 6, background: '#1A1C1F' }} />
        <span className="appearance__scr-bar" style={{ top: 24, left: 11, width: '66%', height: 4, background: '#C3C7CD' }} />
        <span className="appearance__scr-bar" style={{ top: 34, left: 11, width: '54%', height: 4, background: '#C3C7CD' }} />
      </span>
    );
  }
  if (m === 'dark') {
    return (
      <span className="appearance__screen appearance__screen--dark" aria-hidden>
        <span className="appearance__scr-bar" style={{ top: 11, left: 11, width: '44%', height: 6, background: '#E6E8EB' }} />
        <span className="appearance__scr-bar" style={{ top: 24, left: 11, width: '66%', height: 4, background: '#3A3E44' }} />
        <span className="appearance__scr-bar" style={{ top: 34, left: 11, width: '54%', height: 4, background: '#3A3E44' }} />
      </span>
    );
  }
  // system — light base with a dark overlay clipped to the bott-right triangle; content mirrors the split:
  // dark bar + muted line top-left (on the light half), light bar + dim line bottom-right (on the dark half).
  return (
    <span className="appearance__screen appearance__screen--system" aria-hidden>
      <span className="appearance__scr-split" />
      <span className="appearance__scr-bar" style={{ top: 11, left: 11, width: '40%', height: 6, background: '#1A1C1F' }} />
      <span className="appearance__scr-bar" style={{ top: 22, left: 11, width: '30%', height: 4, background: '#C3C7CD' }} />
      <span className="appearance__scr-bar" style={{ bottom: 11, right: 11, width: '40%', height: 6, background: '#E6E8EB' }} />
      <span className="appearance__scr-bar" style={{ bottom: 22, right: 11, width: '30%', height: 4, background: '#4A4E54' }} />
    </span>
  );
}

/**
 * Appearance picker — three preview-driven groups (Palette / Type / Mode) wired to the Lane-0 themeStore.
 * Each setter calls applyToRoot, flipping the data-palette/voice/mode attrs on <html>, so tokens.css
 * repaints the whole app instantly (this screen included) with no reload, and persists device-locally.
 *
 * Palette & Mode render as little app-screen PREVIEW CARDS; Type renders as per-typeface pills. The
 * selected treatment is an accent RING (cards) / soft --sel fill (pills) — the old --ink inversion was
 * dropped as too jarring — so a selected card never tints its background or recolors its preview internals.
 * Selection is state-driven off the store (is-active class), never DOM mutation. Cards stay real <button>s.
 */
export function AppearanceSection() {
  const palette = useThemeStore((s) => s.palette);
  const voice = useThemeStore((s) => s.voice);
  const mode = useThemeStore((s) => s.mode);
  const setPalette = useThemeStore((s) => s.setPalette);
  const setVoice = useThemeStore((s) => s.setVoice);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <section className="settings__section appearance" aria-label="Appearance">
      {/* PALETTE · VIBE — 4 mini app-screen preview cards, each hardcoded to its own palette's light hex */}
      <div className="appearance__group" role="radiogroup" aria-label="Palette">
        <span className="appearance__group-label">Palette · Vibe</span>
        <div className="appearance__cards">
          {PALETTES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={palette === p}
              className={`appearance__card appearance__card--palette${palette === p ? ' is-active' : ''}`}
              // Preview colors come from a static per-palette CSS var map (styles.css), keyed on data-palette —
              // a true preview of THAT palette regardless of the active theme.
              data-palette={p}
              onClick={() => { void setPalette(p); }}
            >
              <span className="appearance__preview" aria-hidden>
                <span className="appearance__preview-nav">
                  <span className="appearance__preview-bar appearance__preview-bar--accent" />
                  <span className="appearance__preview-bar" />
                  <span className="appearance__preview-bar" />
                </span>
                <span className="appearance__preview-content">
                  <span className="appearance__preview-title" />
                  <span className="appearance__preview-line" />
                  <span className="appearance__preview-pill" />
                </span>
              </span>
              <span className="appearance__card-foot">
                <span className="appearance__dot" aria-hidden />
                <span className="appearance__card-label">{PALETTE_LABEL[p]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* TYPE · VOICE — each label rendered in its own font (live specimen) */}
      <div className="appearance__group" role="radiogroup" aria-label="Type voice">
        <span className="appearance__group-label">Type · Voice</span>
        <div className="appearance__pills">
          {VOICES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={voice === v}
              className={`appearance__pill${voice === v ? ' is-active' : ''}`}
              style={{ fontFamily: VOICE_LABEL[v].family, fontSize: VOICE_LABEL[v].size }}
              onClick={() => { void setVoice(v); }}
            >
              {VOICE_LABEL[v].name}
            </button>
          ))}
        </div>
      </div>

      {/* MODE — light / dark / system preview cards (theme-agnostic: always real light vs. dark) */}
      <div className="appearance__group" role="radiogroup" aria-label="Mode">
        <span className="appearance__group-label">Mode</span>
        <div className="appearance__cards">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`appearance__card appearance__card--mode${mode === m ? ' is-active' : ''}`}
              onClick={() => { void setMode(m); }}
            >
              {modeScreen(m)}
              <span className="appearance__card-label">{MODE_LABEL[m]}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="appearance__footnote">
        Changes apply instantly across every surface — no reload. Four palettes × four type voices × light or dark.
      </p>
    </section>
  );
}
