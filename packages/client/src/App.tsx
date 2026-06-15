import { useEffect, useState } from 'react';
import { CORE_BLOCK_TYPES } from '@deltos/shared';

/**
 * Phase 0 shell: empty of features, but real. It paints the host chrome and — to prove the
 * single substrate contract is consumed by the client exactly as by the worker — reads the
 * core block types straight from @deltos/shared. No surfaces, no editor, no data fetch yet;
 * those are Phase 1, and they mount inside this same chrome.
 */
export function App() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__mark">δ deltos</span>
        <span
          className={`shell__net shell__net--${online ? 'online' : 'offline'}`}
          title={online ? 'online' : 'offline — running from cache'}
        >
          {online ? 'online' : 'offline'}
        </span>
      </header>

      <main className="shell__main">
        <p className="shell__lede">An empty surface, installed and offline-ready.</p>
        <p className="shell__sub">
          The substrate spine is wired — {CORE_BLOCK_TYPES.length} core block types are known to
          this client from the shared contract.
        </p>
      </main>
    </div>
  );
}
