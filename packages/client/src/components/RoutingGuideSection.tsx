/**
 * RoutingGuideSection — the "Note routing guide" Settings surface (note-routing-guide spec).
 *
 * A single freeform text field the owner edits to tell Claude where to file saved notes. Loads the current
 * guide on mount, saves on blur (when changed) and on an explicit Save. Empty/whitespace clears it (the
 * server stores null → the agent asks or files under All Notes). The guide is surfaced to the agent via the
 * MCP `list_notebooks` response, so this is the one place the routing rules live.
 *
 * RESIDENCY: statically imported only by SettingsRoute, which is itself `lazy()`-loaded — so it rides the
 * settings chunk and never touches the mobile first-load bundle. Its network client (`routingGuideClient`)
 * is likewise off the entry chunk.
 */
import { useCallback, useEffect, useState } from 'react';
import { ROUTING_GUIDE_MAX } from '@deltos/shared';
import { getRoutingGuide, setRoutingGuide, RoutingGuideError } from '../lib/routingGuideClient.js';

function messageFor(err: unknown): string {
  if (err instanceof RoutingGuideError) return err.message;
  return 'Something went wrong — try again.';
}

/** Normalize a textarea value the way the server does: whitespace-only ⇒ '' (which maps to null on save). */
function normalize(v: string): string {
  return v.trim() === '' ? '' : v;
}

type Load = 'loading' | 'ready' | 'error';
type Save = 'idle' | 'saving' | 'saved';

export function RoutingGuideSection() {
  const [load, setLoad] = useState<Load>('loading');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(''); // last value known to be persisted ('' = unset/null)
  const [save, setSave] = useState<Save>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad('loading');
    setError(null);
    try {
      const g = (await getRoutingGuide()) ?? '';
      setValue(g);
      setSaved(g);
      setLoad('ready');
    } catch (err) {
      setLoad('error');
      setError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async () => {
    if (save === 'saving') return;
    const next = normalize(value);
    if (next === saved) return; // nothing changed — no needless PUT
    setSave('saving');
    setError(null);
    try {
      const stored = (await setRoutingGuide(next === '' ? null : next)) ?? '';
      setValue(stored);
      setSaved(stored);
      setSave('saved');
      window.setTimeout(() => setSave((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (err) {
      setSave('idle');
      setError(messageFor(err));
    }
  };

  const dirty = normalize(value) !== saved;

  return (
    <section className="settings__section" aria-label="Note routing guide">
      <h2 className="settings__section-title">Note routing guide</h2>
      <p className="settings__row-hint">
        Describe where notes should go. Claude reads this when filing saved conversations. If it&rsquo;s ever
        unsure, it asks or files under All Notes.
      </p>

      {load === 'loading' && (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading routing guide…" />
        </div>
      )}

      {load === 'error' && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{error ?? 'Could not load the routing guide.'}</p>
          <button className="settings__row-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {load === 'ready' && (
        <>
          <textarea
            className="settings__guide-textarea"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onBlur={() => void persist()}
            placeholder={
              'e.g.\nDev: software, homelab, infra, coding.\nLife: personal + property, DIY, vehicles.\n' +
              'Default: if unclear, ask; if I’m unavailable, use All Notes.'
            }
            aria-label="Routing guide"
            maxLength={ROUTING_GUIDE_MAX}
            rows={8}
            spellCheck={false}
          />
          <div className="settings__row settings__row--btn-group">
            {error && <p className="settings__error">{error}</p>}
            <button
              className="settings__row-action"
              onClick={() => void persist()}
              disabled={save === 'saving' || !dirty}
              aria-label="Save routing guide"
            >
              {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : 'Save'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
