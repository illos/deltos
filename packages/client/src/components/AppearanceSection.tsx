import { useThemeStore } from '../lib/themeStore.js';
import { PALETTES, VOICES, MODES, type Palette, type Voice, type Mode } from '../db/themePointer.js';

// Human labels + per-axis presentation metadata. Kept here (display concern), not in the store.
const PALETTE_LABEL: Record<Palette, string> = {
  bone: 'Bone', graphite: 'Graphite', manila: 'Manila', ember: 'Ember',
};
// Each voice label is rendered IN its own font via an inline fontFamily, so the chip is a live type
// specimen. We hard-name the family here (the chip overrides the family locally) so the specimen is
// correct even before that voice's lazy woff2 has loaded (falls back to the family's system fallback).
const VOICE_LABEL: Record<Voice, { name: string; family: string }> = {
  serif:   { name: 'Serif',   family: "'Newsreader', Georgia, serif" },
  sans:    { name: 'Sans',    family: "'IBM Plex Sans', system-ui, sans-serif" },
  mono:    { name: 'Mono',    family: "'IBM Plex Mono', ui-monospace, monospace" },
  grotesk: { name: 'Grotesk', family: "'Space Grotesk', system-ui, sans-serif" },
};
const MODE_LABEL: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * Appearance picker — three chip groups (Palette / Type / Mode) wired to the Lane-0 themeStore.
 * Each setter calls applyToRoot, flipping the data-palette/voice/mode attrs on <html>, so tokens.css
 * repaints the whole app instantly (this screen included) with no reload, and persists device-locally.
 * Inline-additive in the Settings list (no sub-view) so it cannot collide with the auth-disclosure copy.
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
      <h2 className="settings__section-title">Appearance</h2>

      {/* PALETTE · VIBE — 4 swatch chips, each previewing its own accent + surface */}
      <div className="appearance__group" role="radiogroup" aria-label="Palette">
        <span className="appearance__group-label">Palette</span>
        <div className="appearance__chips">
          {PALETTES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={palette === p}
              className={`appearance__chip appearance__chip--swatch${palette === p ? ' is-active' : ''}`}
              // Render the chip's OWN palette colors as a live swatch (independent of the active theme),
              // driven by a static CSS map keyed on data-swatch-palette (styles.css).
              data-swatch-palette={p}
              onClick={() => { void setPalette(p); }}
            >
              <span className="appearance__swatch" aria-hidden />
              <span className="appearance__chip-label">{PALETTE_LABEL[p]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* TYPE · VOICE — each label rendered in its own font (live specimen) */}
      <div className="appearance__group" role="radiogroup" aria-label="Type voice">
        <span className="appearance__group-label">Type</span>
        <div className="appearance__chips">
          {VOICES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={voice === v}
              className={`appearance__chip${voice === v ? ' is-active' : ''}`}
              style={{ fontFamily: VOICE_LABEL[v].family }}
              onClick={() => { void setVoice(v); }}
            >
              {VOICE_LABEL[v].name}
            </button>
          ))}
        </div>
      </div>

      {/* MODE — light / dark / system (system = follow OS, the default) */}
      <div className="appearance__group" role="radiogroup" aria-label="Mode">
        <span className="appearance__group-label">Mode</span>
        <div className="appearance__chips appearance__chips--segmented">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`appearance__chip${mode === m ? ' is-active' : ''}`}
              onClick={() => { void setMode(m); }}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
