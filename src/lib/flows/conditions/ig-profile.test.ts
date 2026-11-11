import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ refresh: vi.fn(), windowOpen: vi.fn(), tenant: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (ctx: unknown, work: (tx: unknown) => unknown, client: unknown) => { h.tenant(ctx, client); return work({ tx: true }); },
}));
vi.mock('@/lib/channels/sender', () => ({ instagramAutomatedWindowOpen: h.windowOpen }));
vi.mock('@/lib/instagram/profile', () => ({ refreshProfileFacts: h.refresh }));

import { IG_PROFILE_FACTS } from '../types';
import { IG_CONDITION_FACTS, igProfileSubject, igProfileValue } from './ig-profile';
import { predicateHolds } from '../conditions';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const FACTS = { followsBusiness: true, businessFollows: null, isVerified: false, followerCount: 3 };
const newRun = () => ({ account_id: ACCOUNT, conversation_id: CONVERSATION });

beforeEach(() => {
  vi.clearAllMocks();
  h.refresh.mockResolvedValue(FACTS);
  h.windowOpen.mockResolvedValue(true);
});

describe('igProfileValue', () => {
  it('renders booleans and counts as strings and unknown as absent', () => {
    expect(igProfileValue(FACTS, 'follows_business')).toBe('true');
    expect(igProfileValue(FACTS, 'is_verified')).toBe('false');
    expect(igProfileValue(FACTS, 'follower_count')).toBe('3');
    expect(igProfileValue(FACTS, 'business_follows')).toBeUndefined();
    expect(igProfileValue(null, 'follows_business')).toBeUndefined();
    expect(igProfileValue(FACTS, 'something_else')).toBeUndefined();
  });
  it('resolves exactly the facts the validator accepts', () => {
    expect([...IG_CONDITION_FACTS]).toEqual([...IG_PROFILE_FACTS]);
  });
});

describe('igProfileSubject', () => {
  it('is absent for a run that is not Instagram or has no conversation, and reads nothing', async () => {
    await expect(igProfileSubject(newRun(), 'follows_business', false)).resolves.toBeUndefined();
    await expect(igProfileSubject(newRun(), 'in_window', false)).resolves.toBeUndefined();
    await expect(igProfileSubject({ account_id: ACCOUNT, conversation_id: null }, 'in_window', true)).resolves.toBeUndefined();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.windowOpen).not.toHaveBeenCalled();
  });

  it('reads Meta once per run for several profile rules', async () => {
    const run = newRun();
    await expect(igProfileSubject(run, 'follows_business', true)).resolves.toBe('true');
    await expect(igProfileSubject(run, 'is_verified', true)).resolves.toBe('false');
    await expect(igProfileSubject(newRun(), 'follower_count', true)).resolves.toBe('3');
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.refresh).toHaveBeenCalledWith(ACCOUNT, CONVERSATION);
  });

  it('answers in_window from the database as the run tenant, fresh on every rule', async () => {
    const run = newRun();
    await expect(igProfileSubject(run, 'in_window', true)).resolves.toBe('true');
    h.windowOpen.mockResolvedValue(false);
    await expect(igProfileSubject(run, 'in_window', true)).resolves.toBe('false');
    expect(h.windowOpen).toHaveBeenCalledTimes(2);
    expect(h.windowOpen).toHaveBeenCalledWith({ tx: true }, ACCOUNT, CONVERSATION, expect.any(Date));
    expect(h.tenant).toHaveBeenCalledWith({ accountId: ACCOUNT, role: 'owner' }, { worker: true });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('plugs into the condition operators: "in window" and "follows you" are usable', async () => {
    expect(predicateHolds('equals', await igProfileSubject(newRun(), 'in_window', true), 'true')).toBe(true);
    h.refresh.mockResolvedValue({ ...FACTS, followsBusiness: null });
    // Unknown never passes "follows you = true" and never fails "does not follow" by guessing.
    expect(predicateHolds('equals', await igProfileSubject(newRun(), 'follows_business', true), 'true')).toBe(false);
    expect(predicateHolds('absent', await igProfileSubject(newRun(), 'follows_business', true))).toBe(true);
    expect(predicateHolds('gte', await igProfileSubject(newRun(), 'follower_count', true), '3')).toBe(true);
  });
});
