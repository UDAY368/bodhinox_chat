import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { entitlementsFromTerms, PlanLimitError, requireRoomFor } from './entitlements';

/** A transaction whose entitlement query returns `limits`; records advisory locks. */
function fakeTx(limits: Record<string, unknown>, name = 'Tiny') {
  const locks: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'tiny', name, features: {}, limits, version_id: null, version: null, addons: {} }]),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('pg_advisory_xact_lock')) locks.push(String(values[0]));
      return 1;
    }),
  } as unknown as TenantTransaction;
  return { tx, locks };
}

describe('requireRoomFor', () => {
  it('takes no lock and never counts when the limit is unlimited', async () => {
    const { tx, locks } = fakeTx({ contacts: null });
    const count = vi.fn(async () => 1_000_000);
    await requireRoomFor(tx, 'acct', 'contacts', count, 500);
    await requireRoomFor(tx, 'acct', 'integrations', count); // a missing key is unlimited
    expect(locks).toEqual([]);
    expect(count).not.toHaveBeenCalled();
  });

  it('locks per workspace and key, counts after the lock and checks count + adding', async () => {
    const { tx, locks } = fakeTx({ contacts: 10 });
    await requireRoomFor(tx, 'acct', 'contacts', async () => 7, 3);
    expect(locks).toEqual(['acct:contacts']);
    await expect(requireRoomFor(tx, 'acct', 'contacts', async () => 7, 4)).rejects.toThrow(PlanLimitError);
    await expect(requireRoomFor(tx, 'acct', 'contacts', async () => 10)).rejects.toThrow(/up to 10 contacts/);
  });

  it('never refuses an action that adds nothing, and rejects a negative count', async () => {
    const { tx, locks } = fakeTx({ contacts: 1 });
    await requireRoomFor(tx, 'acct', 'contacts', async () => 50, 0);
    expect(locks).toEqual([]);
    await expect(requireRoomFor(tx, 'acct', 'contacts', async () => 0, -1)).rejects.toThrow();
  });
});

describe('entitlementsFromTerms', () => {
  it('treats missing and null limits as unlimited and adds active add-ons to finite ones', () => {
    const e = entitlementsFromTerms({ planId: 'basic', planName: 'Basic', versionId: 'v', version: 2,
      features: { appointments: true, storefront: 'yes' }, limits: { seats: 3, ai_messages: 100, contacts: null } },
    { extra_seats: 2, ai_messages: 50 });
    expect(e.features.appointments).toBe(true);
    expect(e.features.storefront).toBe(false);
    expect(e.limits).toMatchObject({ seats: 5, ai_messages: 150, contacts: null, integrations: null, messages_monthly: null });
  });
});
