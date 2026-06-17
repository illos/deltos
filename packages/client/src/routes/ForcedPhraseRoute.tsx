/**
 * ForcedPhraseRoute — recovery-phrase belt (P0-belt, @8ada7d9).
 *
 * Rendered when an account has no finalized recovery phrase — either:
 *   - Login path: login() returns recoveryRequired=true → LoginRoute navigates here (isAuthing=true).
 *   - Cold-boot path: init() sees recoveryEstablished=false → selectBootView → 'recovery-gate' →
 *     App renders this directly (no Routes; isAuthed=true).
 *
 * Flow: mount → establishRecovery() [fresh phrase from server] → PhraseStep [save+ack] →
 * await finalizeAuth() [commit cookie + flag] → navigate('/').
 *
 * NEVER call finalizeAuth before the ack: the phrase must be written down first (the P0 latch).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import { PhraseStep } from '../components/PhraseStep.js';

type ScreenState =
  | { tag: 'loading' }
  | { tag: 'ready'; phrase: string }
  | { tag: 'error'; msg: string };

export function ForcedPhraseRoute() {
  const { establishRecovery, finalizeAuth } = useAuthStore();
  const navigate = useNavigate();
  const [screen, setScreen] = useState<ScreenState>({ tag: 'loading' });

  useEffect(() => {
    establishRecovery().then((r) => {
      if (r.ok) {
        setScreen({ tag: 'ready', phrase: r.recoveryPhrase });
      } else {
        setScreen({ tag: 'error', msg: 'Connection error — please try again' });
      }
    }).catch(() => {
      setScreen({ tag: 'error', msg: 'Connection error — please try again' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (screen.tag === 'loading') {
    return (
      <div className="auth">
        <div className="auth__spinner" aria-label="Loading" />
      </div>
    );
  }

  if (screen.tag === 'error') {
    return (
      <div className="auth">
        <h1 className="auth__title">Something went wrong</h1>
        <p className="auth__error">{screen.msg}</p>
        <button
          className="auth__btn auth__btn--primary"
          onClick={() => {
            setScreen({ tag: 'loading' });
            establishRecovery().then((r) => {
              if (r.ok) setScreen({ tag: 'ready', phrase: r.recoveryPhrase });
              else setScreen({ tag: 'error', msg: 'Connection error — please try again' });
            }).catch(() => setScreen({ tag: 'error', msg: 'Connection error — please try again' }));
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const handleAck = async () => {
    const r = await finalizeAuth();
    if (r.ok) {
      navigate('/', { replace: true });
    } else {
      setScreen({ tag: 'error', msg: 'Connection error — please try again' });
    }
  };

  return <PhraseStep phrase={screen.phrase} onAck={handleAck} />;
}
