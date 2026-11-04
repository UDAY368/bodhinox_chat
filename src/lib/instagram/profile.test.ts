import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn(), getProfile: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('./config', () => ({ instagramConfig: () => ({}) }));
vi.mock('./graph', () => ({ getProfile: h.getProfile }));

import { handleProfileFetchJob } from './profile';

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
