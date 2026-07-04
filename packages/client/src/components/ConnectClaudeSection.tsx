/**
 * ConnectClaudeSection — the "Connect to Claude" Settings surface (llm-mcp-integration.md §5 / §4).
 *
 * Lets the owner generate a long-lived, READ-ONLY agent token to paste into a Claude connector (claude.ai
 * custom connector / Claude Desktop / Claude Code), list the active connections, and revoke any of them.
 * The raw token is shown EXACTLY ONCE on mint — there is no "view again", because the server only stores
 * its hash. v1 is read-only by construction (the server clamps scope), so there is no scope picker.
 *
 * RESIDENCY (llm-mcp §4 — lazy off-track route): this section is statically imported only by SettingsRoute,
 * which is itself `lazy()`-loaded in App.tsx, so it rides the settings chunk and never touches the mobile
 * first-load bundle. Its network client (`agentTokensClient`) is likewise off the entry chunk.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listAgentTokens,
  mintAgentToken,
  revokeAgentToken,
  AgentTokenError,
  type AgentToken,
} from '../lib/agentTokensClient.js';
import { useAuthStore } from '../auth/store.js';

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** True iff the token holds any write verb (create/write/delete) — drives the "read & write" label. */
function canWrite(token: AgentToken): boolean {
  return token.scope.some((s) => s === 'create' || s === 'write' || s === 'delete');
}

/**
 * A short human summary of a token's resource SET (grant sets, ROAD-0011 P1) — "All notes" for a workspace
 * grant, else a count like "2 notebooks · 1 note". The rich picker UI is a later lane; this keeps the list
 * row honest about scope.
 */
function resourceSummary(token: AgentToken): string {
  if (token.resources.some((r) => r.kind === 'workspace')) return 'All notes';
  const notebooks = token.resources.filter((r) => r.kind === 'notebook').length;
  const notes = token.resources.filter((r) => r.kind === 'note').length;
  const parts: string[] = [];
  if (notebooks) parts.push(`${notebooks} notebook${notebooks === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'All notes';
}

/** A one-line "Created · access · scope" description for a list row. */
function tokenMeta(token: AgentToken): string {
  const access = canWrite(token) ? 'Read & write' : 'Read-only';
  return `${formatDate(token.createdAt)} · ${access} · ${resourceSummary(token)}`;
}

function messageFor(err: unknown): string {
  if (err instanceof AgentTokenError) return err.message;
  return 'Something went wrong — try again.';
}

/**
 * The generate sub-flow: idle → form (label + STEP-UP re-auth) → minting → minted (token shown once) |
 * error. The `form` step collects the H1 step-up factors (password always; a TOTP code when 2FA is on);
 * a step-up rejection returns to `form` with an inline `error` so the entered fields are not lost.
 */
type GenState =
  | { tag: 'idle' }
  | { tag: 'form'; label: string; password: string; totp: string; allowWrite: boolean; error: string | null }
  | { tag: 'minting' }
  | { tag: 'minted'; token: string; label: string | null }
  | { tag: 'error'; message: string };

export function ConnectClaudeSection() {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gen, setGen] = useState<GenState>({ tag: 'idle' });
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const totpEnabled = useAuthStore((s) => s.totpEnabled);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setTokens(await listAgentTokens());
    } catch (err) {
      setTokens([]);
      setLoadError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitForm = async (form: { label: string; password: string; totp: string; allowWrite: boolean }) => {
    if (!form.password) {
      setGen({ tag: 'form', ...form, error: 'Enter your password to generate a token.' });
      return;
    }
    setGen({ tag: 'minting' });
    setCopied(false);
    try {
      const totp = form.totp.trim();
      const res = await mintAgentToken({
        label: form.label,
        password: form.password,
        ...(totp ? { totp } : {}),
        // A single toggle grants the full write surface (create + edit + trash) — matches "let Claude edit
        // and delete". Least-privilege per-scope splitting exists at the API for later granularity.
        ...(form.allowWrite ? { write: { create: true, update: true, trash: true } } : {}),
      });
      setGen({ tag: 'minted', token: res.token, label: res.label });
      void refresh(); // the new token appears in the list immediately (without its secret)
    } catch (err) {
      // Step-up failure (wrong password / code) → stay in the form with an inline error so the label and
      // entered fields survive; any other failure → the generic error state with a retry.
      if (err instanceof AgentTokenError && err.status === 401) {
        setGen({ tag: 'form', ...form, error: err.message });
      } else {
        setGen({ tag: 'error', message: messageFor(err) });
      }
    }
  };

  const handleCopy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied) — the field stays selectable as the fallback.
    }
  };

  const handleRevoke = async (grantId: string) => {
    setRevoking(grantId);
    try {
      await revokeAgentToken(grantId);
      setConfirmRevoke(null);
      await refresh();
    } catch (err) {
      setLoadError(messageFor(err));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="settings__section" aria-label="Connect to Claude">
      <h2 className="settings__section-title">Connect to Claude</h2>
      <p className="settings__row-hint">
        Claude now connects with <strong>one click</strong> — add deltos&rsquo;s MCP server
        (<code>https://deltos.blackgate.studio/api/mcp</code>) as a connector in Claude and it discovers the
        sign-in automatically; approved apps appear under <strong>Connected apps</strong> below.
      </p>
      <p className="settings__row-hint">
        Prefer to paste a token by hand? Generate a manual connection token below. Tokens are{' '}
        <strong>read-only by default</strong>; you can opt a token into letting Claude create, edit &amp;
        delete notes (deletes go to Trash). Revoke any token anytime.
      </p>

      {/* ── Generate sub-flow ─────────────────────────────────────────────── */}
      {gen.tag === 'idle' && (
        <button
          className="settings__action settings__action--primary"
          onClick={() => setGen({ tag: 'form', label: '', password: '', totp: '', allowWrite: false, error: null })}
        >
          Generate token
        </button>
      )}

      {gen.tag === 'form' && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__row-hint">Confirm your password to generate a token.</p>
          <input
            className="settings__label-input"
            type="text"
            value={gen.label}
            onChange={(e) => setGen({ ...gen, label: e.target.value })}
            placeholder="Label (optional) — e.g. Claude Desktop"
            aria-label="Token label"
            maxLength={200}
            autoFocus
          />
          <input
            className="settings__label-input"
            type="password"
            value={gen.password}
            onChange={(e) => setGen({ ...gen, password: e.target.value, error: null })}
            placeholder="Your password"
            aria-label="Your password"
            autoComplete="current-password"
          />
          {totpEnabled && (
            <input
              className="settings__label-input"
              type="text"
              inputMode="numeric"
              value={gen.totp}
              onChange={(e) => setGen({ ...gen, totp: e.target.value, error: null })}
              placeholder="Two-factor code"
              aria-label="Two-factor code"
              autoComplete="one-time-code"
              maxLength={6}
            />
          )}
          <label className="settings__checkbox-row">
            <input
              type="checkbox"
              checked={gen.allowWrite}
              onChange={(e) => setGen({ ...gen, allowWrite: e.target.checked, error: null })}
              aria-label="Allow Claude to edit and delete notes"
            />
            <span>
              Allow Claude to <strong>create, edit &amp; delete</strong> notes (deletes go to Trash and are
              recoverable). Leave off for read-only access.
            </span>
          </label>
          {gen.error && <p className="settings__error">{gen.error}</p>}
          <button
            className="settings__row-action"
            onClick={() =>
              void submitForm({ label: gen.label, password: gen.password, totp: gen.totp, allowWrite: gen.allowWrite })
            }
            aria-label="Create token"
          >
            Create
          </button>
          <button className="settings__row-action" onClick={() => setGen({ tag: 'idle' })}>
            Cancel
          </button>
        </div>
      )}

      {gen.tag === 'minting' && (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Generating token…" />
        </div>
      )}

      {gen.tag === 'minted' && (
        <div className="settings__token-box">
          <p className="settings__token-warning">
            Copy this token now — you won&rsquo;t be able to see it again.
          </p>
          <textarea
            className="settings__token-value"
            readOnly
            rows={2}
            value={gen.token}
            aria-label="Agent token"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="settings__token-box-actions">
            <button
              className="settings__row-action"
              onClick={() => void handleCopy(gen.token)}
              aria-label="Copy token"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button className="settings__row-action" onClick={() => setGen({ tag: 'idle' })}>
              Done
            </button>
          </div>
        </div>
      )}

      {gen.tag === 'error' && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{gen.message}</p>
          <button
            className="settings__row-action"
            onClick={() => setGen({ tag: 'form', label: '', password: '', totp: '', allowWrite: false, error: null })}
          >
            Try again
          </button>
        </div>
      )}

      {/* ── Active connections list ───────────────────────────────────────── */}
      {tokens === null ? (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading connections…" />
        </div>
      ) : tokens.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">
            No connections yet.
          </span>
        </div>
      ) : (
        tokens.map((token) => {
          const isConfirming = confirmRevoke === token.tokenId;
          const isRevoking = revoking === token.tokenId;
          return (
            <div key={token.tokenId} className="settings__row">
              <span className="settings__token-row-main">
                <span className="settings__row-label">{token.label || 'Untitled token'}</span>
                <span className="settings__token-meta">{tokenMeta(token)}</span>
              </span>
              {isConfirming ? (
                <>
                  <button
                    className="settings__row-action"
                    onClick={() => void handleRevoke(token.tokenId)}
                    disabled={isRevoking}
                    aria-label={`Confirm revoke ${token.label || 'token'}`}
                  >
                    {isRevoking ? 'Revoking…' : 'Confirm'}
                  </button>
                  <button
                    className="settings__row-action"
                    onClick={() => setConfirmRevoke(null)}
                    disabled={isRevoking}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="settings__row-action"
                  onClick={() => setConfirmRevoke(token.tokenId)}
                  aria-label={`Revoke ${token.label || 'token'}`}
                >
                  Revoke
                </button>
              )}
            </div>
          );
        })
      )}

      {loadError && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{loadError}</p>
          <button className="settings__row-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {/* Endpoint slot — wired once the MCP server slice lands (llm-mcp §6). Kept as a clearly-labelled
          placeholder so adding the real connection URL here is a one-line change, not a re-layout. */}
      <p className="settings__row-hint">
        Connection endpoint — shown here once the Claude connector ships.
      </p>
    </section>
  );
}
