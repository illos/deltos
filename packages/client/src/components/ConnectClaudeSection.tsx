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

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A one-line "Created · Read-only · scope" description for a list row. */
function tokenMeta(token: AgentToken): string {
  const where = token.resourceKind === 'notebook' ? 'One notebook' : 'All notes';
  return `${formatDate(token.createdAt)} · Read-only · ${where}`;
}

function messageFor(err: unknown): string {
  if (err instanceof AgentTokenError) return err.message;
  return 'Something went wrong — try again.';
}

/** The generate sub-flow: idle → naming (optional label) → minting → minted (token shown once) | error. */
type GenState =
  | { tag: 'idle' }
  | { tag: 'naming'; label: string }
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

  const handleGenerate = async (label: string) => {
    setGen({ tag: 'minting' });
    setCopied(false);
    try {
      const res = await mintAgentToken(label);
      setGen({ tag: 'minted', token: res.token, label: res.label });
      void refresh(); // the new token appears in the list immediately (without its secret)
    } catch (err) {
      setGen({ tag: 'error', message: messageFor(err) });
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
        Generate a token to connect Claude (claude.ai, Claude Desktop, or Claude Code) to your notes.
        Access is <strong>read-only</strong> and you can revoke it anytime.
      </p>

      {/* ── Generate sub-flow ─────────────────────────────────────────────── */}
      {gen.tag === 'idle' && (
        <button
          className="settings__action settings__action--primary"
          onClick={() => setGen({ tag: 'naming', label: '' })}
        >
          Generate token
        </button>
      )}

      {gen.tag === 'naming' && (
        <div className="settings__row">
          <input
            className="settings__label-input"
            type="text"
            value={gen.label}
            onChange={(e) => setGen({ tag: 'naming', label: e.target.value })}
            placeholder="Label (optional) — e.g. Claude Desktop"
            aria-label="Token label"
            maxLength={200}
            autoFocus
          />
          <button
            className="settings__row-action"
            onClick={() => void handleGenerate(gen.label)}
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
          <button className="settings__row-action" onClick={() => setGen({ tag: 'naming', label: '' })}>
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
          const isConfirming = confirmRevoke === token.grantId;
          const isRevoking = revoking === token.grantId;
          return (
            <div key={token.grantId} className="settings__row">
              <span className="settings__token-row-main">
                <span className="settings__row-label">{token.label || 'Untitled token'}</span>
                <span className="settings__token-meta">{tokenMeta(token)}</span>
              </span>
              {isConfirming ? (
                <>
                  <button
                    className="settings__row-action"
                    onClick={() => void handleRevoke(token.grantId)}
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
                  onClick={() => setConfirmRevoke(token.grantId)}
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
