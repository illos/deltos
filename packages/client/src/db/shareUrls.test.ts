/**
 * shareUrls store (ROAD-0011 P2) — client-local, account-isolated memory of minted share URLs.
 *
 * Proves: save→get round-trips a url; get is scoped by accountId (account B never sees account A's url);
 * bulk get returns only the known ids; delete forgets one; a null accountId is an inert no-op; and the
 * whole table is dropped by the account-scope wipe (isolation belt, #52 lineage).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(async () => {
  const { db } = await import('./schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('shareUrls store', () => {
  it('round-trips a saved url, scoped to the account that minted it', async () => {
    const { saveShareUrl, getShareUrls } = await import('./shareUrls.js');
    await saveShareUrl('acct-A', 's1', 'https://x/s/tokA');

    expect(await getShareUrls('acct-A', ['s1'])).toEqual({ s1: 'https://x/s/tokA' });
    // Account B, same shareId, sees NOTHING (compound-PK isolation).
    expect(await getShareUrls('acct-B', ['s1'])).toEqual({});
  });

  it('bulk-get returns only the ids that are locally known', async () => {
    const { saveShareUrl, getShareUrls } = await import('./shareUrls.js');
    await saveShareUrl('acct-A', 's1', 'https://x/s/1');
    await saveShareUrl('acct-A', 's3', 'https://x/s/3');

    expect(await getShareUrls('acct-A', ['s1', 's2', 's3'])).toEqual({
      s1: 'https://x/s/1',
      s3: 'https://x/s/3',
    });
  });

  it('delete forgets a single url; other rows survive', async () => {
    const { saveShareUrl, getShareUrls, deleteShareUrl } = await import('./shareUrls.js');
    await saveShareUrl('acct-A', 's1', 'https://x/s/1');
    await saveShareUrl('acct-A', 's2', 'https://x/s/2');

    await deleteShareUrl('acct-A', 's1');
    expect(await getShareUrls('acct-A', ['s1', 's2'])).toEqual({ s2: 'https://x/s/2' });
  });

  it('is an inert no-op for a null account (unauthed)', async () => {
    const { saveShareUrl, getShareUrls } = await import('./shareUrls.js');
    await saveShareUrl(null, 's1', 'https://x/s/1'); // no write
    expect(await getShareUrls(null, ['s1'])).toEqual({});
  });

  it('is dropped by the account-scope wipe (isolation)', async () => {
    const { saveShareUrl, getShareUrls } = await import('./shareUrls.js');
    const { purgeAllLocalState } = await import('./accountScope.js');
    await saveShareUrl('acct-A', 's1', 'https://x/s/1');

    await purgeAllLocalState();
    expect(await getShareUrls('acct-A', ['s1'])).toEqual({});
  });
});
