/**
 * EditorTab — custom dictionary + the Developer toggles (custom keyboard, spellcheck).
 *
 * The custom-keyboard row keeps its `keypadCapable` visibility gate: it is installed-PWA-only AND
 * touch-first-only (it swaps the native keyboard for the Deck keypad, which only makes sense in the
 * standalone app on a finger-driven device). Shown only where the keypad can actually engage — a
 * plain mobile browser tab lacks the surface, and a DESKTOP-installed PWA is standalone but
 * pointer-fine — so neither offers the setting. (The useKeypadMode gate handles the "no effect" part
 * when the stored preference is on but the device can't engage; this just keeps Settings honest.)
 */
import { useNavigate } from 'react-router-dom';
import { CustomDictSection } from '../../components/CustomDictSection.js';
import { useCustomKeyboard } from '../../lib/useCustomKeyboard.js';
import { useInstalledPwa } from '../../lib/useInstalledPwa.js';
import { useTouchPrimary } from '../../lib/useTouchPrimary.js';
import { useSpellcheck } from '../../lib/useSpellcheck.js';
import { SettingsPane, type SettingsVariant } from './SettingsPane.js';

export function EditorTab({ variant }: { variant: SettingsVariant }) {
  const navigate = useNavigate();
  const [customKeyboard, setCustomKeyboard] = useCustomKeyboard();
  const installedPwa = useInstalledPwa();
  const touchPrimary = useTouchPrimary();
  const keypadCapable = installedPwa && touchPrimary;
  const [spellcheck, setSpellcheck] = useSpellcheck();

  return (
    <SettingsPane variant={variant} title="Editor" onBack={() => navigate('/settings')}>
      {/* Custom dictionary (§5.2 manage-UI) */}
      <CustomDictSection />

      {/* Developer / experimental toggles (the #68 keyboard-probe entry was removed with the probe). */}
      <section className="settings__section" aria-label="Developer">
        <h2 className="settings__section-title">Developer</h2>
        {/* #69 custom-keyboard opt-in — default OFF, device-local. ON = the real mobile editor uses our
            keyboard (no native, no numbers yet); OFF = native keyboard as today. Shown only where the keypad
            can engage (installed PWA + touch-first): hidden in a browser tab AND in a desktop-installed PWA. */}
        {keypadCapable && (
          <button
            className="settings__row settings__row--btn"
            role="switch"
            aria-checked={customKeyboard}
            onClick={() => setCustomKeyboard(!customKeyboard)}
          >
            <span className="settings__row-label">Custom keyboard (experimental)</span>
            <span className={`settings__row-value${customKeyboard ? '' : ' settings__row-value--muted'}`}>
              {customKeyboard ? 'On' : 'Off'}
            </span>
          </button>
        )}
        {/* #69 §5 local spellcheck — default ON, device-local. ON = live squiggles + tap-to-correct (engine
            loads off-thread on demand); OFF = no squiggles, engine never loads. */}
        <button
          className="settings__row settings__row--btn"
          role="switch"
          aria-checked={spellcheck}
          onClick={() => setSpellcheck(!spellcheck)}
        >
          <span className="settings__row-label">Spellcheck</span>
          <span className={`settings__row-value${spellcheck ? '' : ' settings__row-value--muted'}`}>
            {spellcheck ? 'On' : 'Off'}
          </span>
        </button>
      </section>
    </SettingsPane>
  );
}
