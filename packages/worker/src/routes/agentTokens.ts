import { Hono } from 'hono';
import { z } from 'zod';
import {
  MintAgentTokenRequestSchema,
  RevokeAgentTokenRequestSchema,
  clampToReadOnlyScopes,
  type Resource,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError } from '../http.js';
import { createAuthStore } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { hashToken, randomToken } from '../authCrypto.js';
import { stampAccountId } from '../db/accountScope.js';
import { verifyStepUp } from '../stepUp.js';
import { MINT_BACKOFF, backoffDelayMs } from '../authPolicy.js';

/**
 * Agent-token surface (llm-mcp-integration.md §5) — three OWNER-authed routes that mint, list, and revoke
 * the long-lived read-only credential a remote MCP connector (Claude) bears. An agent token is just a
 * `grants` row with principalKind='agent', non-expiring, scope-clamped read-only, principalId = the
 * owner's accountId.
 *
 * AUTHZ: every route runs through the SAME `guard()` chokepoint the PWA uses, with op `'share'`. That op
 * is the linchpin of two invariants:
 *   1. The owner's session grant carries the full scope (incl. 'share'), so the human owner is authorized.
 *   2. An AGENT token's scope is clamped to ['read','search'] — it has NO 'share' — so an agent token can
 *      NEVER mint/list/revoke tokens (it 403s at the chokepoint). Managing access IS the 'share' capability.
 *
 * ACCOUNT-SCOPING: the owning account is ALWAYS the server-derived `principal.id` (= accountId after the
 * 0003 re-point). It is NEVER read from the request body. So a minted agent token reads exactly the
 * owner's account (the data layer scopes on principalId), and revoke is BOLA-checked on principalId.
 *
 * RESIDENCY: server (llm-mcp §4) — pure backend plumbing, adds zero to the client bundle.
 */
export const agentTokens = new Hono<AppEnv>();

/**
 * POST /api/agent-tokens — mint a read-only agent token. Body: { label?, scope?, notebookId? }.
 * Returns the raw token ONCE (only its SHA-256 is persisted) plus the non-secret metadata.
 */
agentTokens.post(
  '/',
  guard({
    op: 'share',
    schema: MintAgentTokenRequestSchema,
    input: async (c) => {
      try {
        return await c.req.json();
      } catch {
        return {}; // empty body = all-defaults mint (full read-only surface, workspace scope)
      }
    },
    // Authorize the owner against the resource being scoped (a notebook, else the whole workspace).
    resource: (req): Resource =>
      req.notebookId ? { kind: 'notebook', id: req.notebookId } : { kind: 'workspace' },
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      // The owning account is the AUTHENTICATED owner's principal.id — server-derived, never the body.
      const accountId = stampAccountId(principal);
      const nowMs = Date.now();

      // C RATE-LIMIT (ROAD-0005 P0): per-account backoff GATE that runs BEFORE the step-up Argon2
      // (gate-before-hash) — caps password-guessing by a borrowed live session + the Argon2-per-attempt
      // CPU-amplification lever (H1 review MED). Reuses the existing authThrottle store.
      const bucket = `mint:${accountId}`;
      const throttle = await store.getThrottle(bucket);
      if (throttle && nowMs < throttle.nextAllowedMs) {
        return apiError(c, 429, 'too_many_attempts', 'too many attempts — try again shortly');
      }

      // H1 STEP-UP: a live session bearer is NOT enough to mint a long-lived, non-expiring read-all
      // credential — re-prove the human (password, + TOTP if 2FA is on). Fail-closed: any failure returns
      // the apiError unchanged and NO grant is minted. Runs BEFORE any token generation.
      const stepUp = await verifyStepUp(c, store, accountId, { password: req.password, totp: req.totp }, nowMs);
      if (stepUp) {
        // A wrong factor (401) counts toward the backoff; config/prompt failures (503) do not.
        if (stepUp.status === 401) {
          const failures = ((await store.getThrottle(bucket))?.failures ?? 0) + 1;
          await store.recordThrottleFailure(
            bucket,
            failures,
            nowMs + backoffDelayMs(MINT_BACKOFF, failures),
            new Date(nowMs).toISOString(),
          );
        }
        return stepUp;
      }
      await store.clearThrottle(bucket); // success — reset the per-account backoff

      const now = new Date().toISOString();

      // CLAMP read-only at mint (fail-closed): any write/create/delete/share verb is dropped here.
      const scope = clampToReadOnlyScopes(req.scope);
      const resource: Resource = req.notebookId
        ? { kind: 'notebook', id: req.notebookId }
        : { kind: 'workspace' };
      const label = req.label ?? null;

      // Recognizable prefix + 32 bytes CSPRNG. Only SHA-256(token) is stored; the raw token is returned once.
      const token = `dltos_agent_${randomToken(32)}`;
      const grantId = randomToken(16);

      await store.insertAgentGrant({
        grantId,
        tokenHash: hashToken(token),
        accountId,
        label,
        resource,
        scope,
        createdAt: now,
      });

      return c.json(
        {
          token, // returned EXACTLY once — never persisted, never re-served
          grantId,
          label,
          scope,
          resourceKind: resource.kind,
          resourceId: req.notebookId ?? null,
          createdAt: now,
        },
        201,
      );
    },
  }),
);

/** GET /api/agent-tokens — list this account's active agent tokens (NEVER the token or its hash). */
agentTokens.get(
  '/',
  guard({
    op: 'share',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const tokens = await store.listAgentGrantsForAccount(accountId);
      return c.json({ tokens });
    },
  }),
);

/**
 * DELETE /api/agent-tokens/:grantId — revoke an agent token. BOLA-checked: the store revokes ONLY when
 * the grant is owned by the caller's account; a non-match (other account, or no such grant) revokes zero
 * rows → 404 (not 403 — no cross-account existence disclosure).
 */
agentTokens.delete(
  '/:grantId',
  guard({
    op: 'share',
    schema: RevokeAgentTokenRequestSchema,
    input: (c) => ({ grantId: c.req.param('grantId') }),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const revoked = await store.revokeAgentGrantForAccount(req.grantId, accountId);
      if (revoked === 0) {
        // Not found, not owned by this account, or already revoked — all indistinguishable, all 404.
        return apiError(c, 404, 'not_found', 'agent token not found');
      }
      return c.json({ grantId: req.grantId, revoked: true });
    },
  }),
);
