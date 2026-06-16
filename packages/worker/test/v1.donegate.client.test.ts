/**
 * v1 DONE-GATE — TIER A: headless client suite (automatable [CLI-auto] half).
 *
 * The client SIBLING of v1.donegate.test.ts ([SRV]), co-located in the worker test pkg so the whole
 * done-gate lives in one package (scopeSys ruling 282cca7) and the sync legs can drive the REAL
 * client syncEngine against the REAL worker Hono app (fetch → app.request, over better-sqlite3 +
 * migrations 0000-0003). Tier B = on-device iPhone dogfood (planSys runbook 282cca7), NOT here.
 *
 * Single-editor: devSys2. Client-lane scenario specs (DG-1b/2b/3d-F7) from gruntSys2; sync/editor
 * scenarios (DG-2d/3d-header/3e + the sync-e2e DG-3a/2c/5c-echo) are mine.
 *
 * Coverage: DG-1b enrollNew/enrollExisting determinism · DG-2b offline persistence LOGIC ·
 * DG-2d block-id stability · DG-3d auth-header + F7 token-never-at-rest · DG-3e sync-indicator ·
 * DG-3a sync round-trip · DG-2c offline reconcile · DG-5c-echo cross-account isolation.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { generateMnemonic, deriveKeyHierarchy } from '@deltos/client/src/identity/keyDerivation.js';
import { syncNow, getSyncState } from '@deltos/client/src/lib/syncEngine.js';
import { mutateNotes } from '@deltos/client/src/db/mutate.js';
import { useAuthStore } from '@deltos/client/src/auth/store.js';
import app from '../src/index.js';

// --- resolution sanity (probe): cross-package + worker-app imports must resolve under vitest ---
describe('Tier-A harness wiring', () => {
  it('resolves @deltos/client source imports + the worker app from the worker test pkg', () => {
    expect(typeof generateMnemonic).toBe('function');
    expect(typeof deriveKeyHierarchy).toBe('function');
    expect(typeof syncNow).toBe('function');
    expect(typeof getSyncState).toBe('function');
    expect(typeof mutateNotes.put).toBe('function');
    expect(typeof useAuthStore.getState).toBe('function');
    expect(typeof app.request).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// DG-1b — enrollNew vs enrollExisting: fresh-account intent ≠ recovery; recovering the SAME
// mnemonic yields the SAME identity (no silent account orphan). Pure derivation determinism
// (deriveKeyHierarchy is jsdom-safe crypto; the WebAuthn ceremony is not exercised here). [PIN-ID-8]
// Spec: gruntSys2.
// ---------------------------------------------------------------------------

describe('DG-1b — enroll determinism (enrollNew vs enrollExisting)', () => {
  it('the SAME mnemonic re-derives the SAME identity.id + signing pubkey (recovery, no orphan)', async () => {
    const m1 = generateMnemonic();
    const h1 = await deriveKeyHierarchy(m1);
    const h2 = await deriveKeyHierarchy(m1); // enrollExisting path: same mnemonic

    expect(h2.id).toBe(h1.id); // accountFingerprint = base64url(SHA-256(signing pubkey)) — stable
    expect(h2.signing.publicKey).toEqual(h1.signing.publicKey); // byte-identical
  });

  it('a DIFFERENT mnemonic produces a DIFFERENT identity.id (distinct accounts, no clobber)', async () => {
    const h1 = await deriveKeyHierarchy(generateMnemonic());
    const h3 = await deriveKeyHierarchy(generateMnemonic()); // enrollNew: fresh entropy

    expect(h3.id).not.toBe(h1.id);
  });

  it('generateMnemonic yields a fresh 24-word phrase each call (enrollNew = fresh entropy)', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    expect(a.split(/\s+/)).toHaveLength(24);
    expect(a).not.toBe(b);
  });
});
