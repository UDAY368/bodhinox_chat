import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn(), getProfile: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('./config', () => ({ instagramConfig: () => ({}) }));
vi.mock('./graph', () => ({ getProfile: h.getProfile }));

import { handleProfileFetchJob, refreshProfileFacts } from './profile';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const IDENTITY = '33333333-3333-4333-8333-333333333333';
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([{ external_id: '9001', contact_id: 'c1', access_token_enc: 'enc', status: 'active', username: null, display_name: null }]);
  h.executeRaw.mockResolvedValue(1);
});

describe('handleProfileFetchJob', () => {
  it('sets only the display name on an unnamed contact, never the username or IGSID', async () => {
    h.getProfile.mockResolvedValue({ name: 'Jane Doe', username: 'janedoe' });
    await handleProfileFetchJob(ACCOUNT, { identityId: IDENTITY });
    const contactUpdate = h.executeRaw.mock.calls.find((c) => sqlOf(c).includes('UPDATE contacts'))!;
    expect(contactUpdate.slice(1)).toContain('Jane Doe');
    expect(sqlOf(contactUpdate)).toContain('name IS NULL');
    const identityUpdate = h.executeRaw.mock.calls.find((c) => sqlOf(c).includes('UPDATE contact_channel_identities'))!;
    expect(identityUpdate.slice(1)).toEqual(expect.arrayContaining(['janedoe', 'Jane Doe']));
  });

  it('keeps the username on the identity only when the profile has no display name', async () => {
    h.getProfile.mockResolvedValue({ name: null, username: 'janedoe' });
    await handleProfileFetchJob(ACCOUNT, { identityId: IDENTITY });
    expect(h.executeRaw.mock.calls.some((c) => sqlOf(c).includes('UPDATE contacts'))).toBe(false);
    const written = JSON.stringify(h.executeRaw.mock.calls.flatMap((c) => c.slice(1)));
    expect(written).not.toContain('@janedoe');
    expect(written).not.toContain('9001');
  });
});

describe('refreshProfileFacts (the follow gate)', () => {
  const CONVERSATION = '44444444-4444-4444-8444-444444444444';
  const storedRow = { identity_id: IDENTITY, external_id: '9001', access_token_enc: 'enc', status: 'active',
    follows_business: false, business_follows: null, is_verified: null, ig_follower_count: 12 };

  it('reads the facts live and stores them on the identity', async () => {
    h.queryRaw.mockResolvedValue([storedRow]);
    h.getProfile.mockResolvedValue({ name: null, username: null,
      facts: { followsBusiness: true, businessFollows: false, isVerified: false, followerCount: 40 } });
    await expect(refreshProfileFacts(ACCOUNT, CONVERSATION)).resolves.toEqual(
      { followsBusiness: true, businessFollows: false, isVerified: false, followerCount: 40 });
    const update = h.executeRaw.mock.calls.find((c) => sqlOf(c).includes('UPDATE contact_channel_identities'))!;
    expect(sqlOf(update)).toContain('profile_checked_at=now()');
    expect(update.slice(1)).toEqual(expect.arrayContaining([true, false, 40, ACCOUNT, IDENTITY]));
  });

  it('falls back to the stored facts when Meta refuses or the network fails, and writes nothing', async () => {
    h.queryRaw.mockResolvedValue([storedRow]);
    for (const failure of [Object.assign(new Error('refused'), { name: 'MetaApiError' }), new TypeError('fetch failed')]) {
      h.getProfile.mockRejectedValueOnce(failure);
      await expect(refreshProfileFacts(ACCOUNT, CONVERSATION)).resolves.toEqual(
        { followsBusiness: false, businessFollows: null, isVerified: null, followerCount: 12 });
    }
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('is null for a conversation that is not an Instagram one of this workspace', async () => {
    h.queryRaw.mockResolvedValue([]);
    await expect(refreshProfileFacts(ACCOUNT, CONVERSATION)).resolves.toBeNull();
    await expect(refreshProfileFacts(ACCOUNT, 'not-a-uuid')).resolves.toBeNull();
    expect(h.getProfile).not.toHaveBeenCalled();
  });
});
