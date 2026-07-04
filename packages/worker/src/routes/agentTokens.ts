import { Hono } from 'hono';
import { z } from 'zod';
import {
  MintAgentTokenRequestSchema,
  RevokeAgentTokenRequestSchema,
  clampAgentScopes,
  clampAgentResources,
  type Resource,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError } from '../http.js';
import { createAuthStore } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { createResourceOwnerResolver } from '../db/resourceOwner.js';
import { hashToken, randomToken } from '../authCrypto.js';
import { stampAccountId } from '../db/accountScope.js';
import { audit, credentialRefOf } from '../audit.js';
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
    // Authorize the owner at WORKSPACE level — the human owner holds `share` over their whole workspace, so
    // they may mint a token for any of their OWN resources. Which specific notebooks/notes are in the set is
    // clamped + ownership-validated in the handler (a foreign/absent selection is rejected there).
    resource: (): Resource => ({ kind: 'workspace' }),
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
          // P3 lifecycle: a live session that failed the mint step-up — a high-value security signal
          // (a borrowed session attempting to mint a read-all credential without the password/2FA).
          await audit(c, {
            surface: 'auth',
            action: 'token.mint',
            result: 'deny',
            principalKind: principal.kind,
            accountId,
            credentialRef: credentialRefOf(principal),
            detail: 'step-up-failed',
          });
        }
        return stepUp;
      }
      await store.clearThrottle(bucket); // success — reset the per-account backoff

      const now = new Date().toISOString();

      // CLAMP at mint (fail-closed): READ is the floor; WRITE verbs are added ONLY for the explicit
      // per-scope opt-in in `req.write` (least-privilege). `share` can never appear. No opt-in → read-only,
      // exactly as before. The step-up above already re-proved the human — warranted for a write mint.
      const scope = clampAgentScopes(req.scope, req.write ? { allowWrite: req.write } : undefined);
      // CLAMP the RESOURCE SET (the second half of the ONE mint clamp): normalize/dedupe/collapse-to-
      // workspace; absent ⇒ the whole workspace. Only what survives is persisted (grant sets, ROAD-0011 P1).
      const resources = clampAgentResources(req.resources);
      // OWNERSHIP VALIDATION (fail-closed): every non-workspace selection MUST belong to the minter's account.
      // A foreign/absent resource is rejected — otherwise it would mint an INERT grant (the canWith belt would
      // never let it cover anything anyway; this makes the footgun a clear 400 instead of a silent dud).
      const resolveOwner = createResourceOwnerResolver(d1Adapter(c.env.DB));
      for (const r of resources) {
        if (r.kind === 'workspace') continue;
        const owner = await resolveOwner(r);
        if (!owner || owner.accountId !== accountId) {
          return apiError(c, 400, 'invalid_resource', `resource not found in your account: ${r.kind} ${r.id}`);
        }
      }
      const label = req.label ?? null;

      // Recognizable prefix + 32 bytes CSPRNG. Only SHA-256(token) is stored; the raw token is returned once.
      const token = `dltos_agent_${randomToken(32)}`;
      // The whole-token id shared by every row of the set (the revoke-whole-token + listing grouping key);
      // each resource additionally gets its own row grantId (the per-resource revoke target).
      const tokenGroupId = randomToken(16);
      const rows = resources.map((resource) => ({ grantId: randomToken(16), resource }));

      await store.insertAgentGrantSet({
        tokenGroupId,
        tokenHash: hashToken(token),
        accountId,
        label,
        scope,
        createdAt: now,
        rows,
      });

      const resourceView = rows.map((r) => ({
        grantId: r.grantId,
        kind: r.resource.kind,
        id: r.resource.kind === 'workspace' ? null : r.resource.id,
      }));

      // P3 lifecycle: a new long-lived read-all credential was minted. tokenGroupId is the credentialRef so a
      // later revoke / agent-access line ties back to this birth event; detail carries the resource SET.
      const primaryResource = resources[0] ?? { kind: 'workspace' as const };
      await audit(c, {
        surface: 'auth',
        action: 'token.mint',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: tokenGroupId,
        resourceKind: primaryResource.kind,
        resourceId: primaryResource.kind === 'workspace' ? null : primaryResource.id,
        detail: `agent-token ${resourceView.map((r) => r.kind + (r.id ? `:${r.id}` : '')).join(',')}`,
      });

      return c.json(
        {
          token, // returned EXACTLY once — never persisted, never re-served
          tokenId: tokenGroupId,
          label,
          scope,
          resources: resourceView,
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
 * DELETE /api/agent-tokens/:grantId — revoke ONE resource of a token (per-resource revocation, ROAD-0011 P1
 * §1.2): with grant sets a token is N rows, so revoking a single grantId drops just that notebook/note from
 * the token while its siblings stay live (revoke one notebook without re-minting). BOLA-checked: the store
 * revokes ONLY when the row is owned by the caller's account; a non-match revokes zero rows → 404 (not 403 —
 * no cross-account existence disclosure). To revoke the WHOLE token, use DELETE /token/:tokenId.
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
      // P3 lifecycle: an agent credential was revoked. detail = the revoked grantId (the credential the
      // act targets); credentialRef = the acting session that performed the revoke.
      await audit(c, {
        surface: 'auth',
        action: 'token.revoke',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: credentialRefOf(principal),
        detail: req.grantId,
      });
      return c.json({ grantId: req.grantId, revoked: true });
    },
  }),
);

/**
 * DELETE /api/agent-tokens/token/:tokenId — revoke a WHOLE token (all resources of a grant set at once — the
 * "revoke this connection" button). BOLA-checked in the store (account match + first-party IN the WHERE); a
 * non-match revokes zero rows → 404 (no cross-account existence disclosure). Immediate: the next request
 * bearing the token 401s at the transport (no live row) / 403s at can().
 */
agentTokens.delete(
  '/token/:tokenId',
  guard({
    op: 'share',
    schema: z.object({ tokenId: z.string().min(1) }).strict(),
    input: (c) => ({ tokenId: c.req.param('tokenId') }),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const revoked = await store.revokeAgentTokenGroupForAccount(req.tokenId, accountId);
      if (revoked === 0) {
        // Not found, not owned by this account, or already revoked — all indistinguishable, all 404.
        return apiError(c, 404, 'not_found', 'agent token not found');
      }
      await audit(c, {
        surface: 'auth',
        action: 'token.revoke',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: credentialRefOf(principal),
        detail: `token:${req.tokenId}`,
      });
      return c.json({ tokenId: req.tokenId, revoked: true });
    },
  }),
);
