import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plans: [] as { id: string; currentVersion: number; features: Record<string, unknown> }[],
  preview: vi.fn(),
  publish: vi.fn(),
  move: vi.fn(),
  enforce: vi.fn(),
}));
vi.mock('./db', async (original) => ({
  PlatformDbError: (await original<typeof import('./db')>()).PlatformDbError,
  platformPlans: async () => h.plans,
  platformPlanPrices: async () => [],
  platformPlanVersions: async () => [],
  platformPlanPreview: h.preview,
  platformPublishPlanVersion: h.publish,
  platformMovePlanSubscribers: h.move,
}));
vi.mock('@/lib/billing/downgrade', () => ({ enforcePlanLimits: h.enforce }));

import { FEATURES, LIMITS } from '@/lib/billing/entitlements-catalogue';
import { assertPlanRules, moveSubscribers, parsePlanDraft, PlanDraftError, previewPlan, publishPlan } from './plans';

const admin = { userId: 'u', sessionId: 's', email: 'ops@example.test' };
const HASH = 'a'.repeat(64);
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as PlanDraftError).code);

beforeEach(() => {
  vi.clearAllMocks();
  h.plans = [
    { id: 'enterprise', currentVersion: 1, features: { instagram: true, appointments: true } },
    { id: 'pro', currentVersion: 3, features: { instagram: true } },
  ];
  h.preview.mockResolvedValue({ preview_hash: HASH });
  h.publish.mockResolvedValue(4);
  h.move.mockResolvedValue([]);
});

describe('parsePlanDraft', () => {
  it('normalises to every catalogue key in catalogue order (missing feature off, missing limit unlimited)', () => {
    const d = parsePlanDraft({ features: { instagram: true }, limits: { seats: 3 } });
    expect(Object.keys(d.features)).toEqual([...FEATURES]);
    expect(Object.keys(d.limits)).toEqual([...LIMITS]);
    expect(d.features.instagram).toBe(true);
    expect(d.features.storefront).toBe(false);
    expect(d.limits.seats).toBe(3);
    expect(d.limits.contacts).toBeNull();
    // Same draft, different key order: identical JSON (the preview hash depends on it).
    expect(JSON.stringify(parsePlanDraft({ limits: { seats: 3 }, features: { instagram: true } }))).toBe(JSON.stringify(d));
  });

  it.each([
    ['unknown feature', { features: { teleport: true }, limits: {} }],
    ['non-boolean feature', { features: { instagram: 'yes' }, limits: {} }],
    ['unknown limit', { features: {}, limits: { galaxies: 1 } }],
    ['negative limit', { features: {}, limits: { seats: -1 } }],
    ['fractional limit', { features: {}, limits: { seats: 1.5 } }],
    ['unsafe limit', { features: {}, limits: { seats: 2 ** 60 } }],
    ['string limit', { features: {}, limits: { seats: '3' } }],
    ['missing parts', { features: {} }],
    ['array', []],
  ])('refuses %s', (_name, raw) => {
    expect(() => parsePlanDraft(raw)).toThrow(PlanDraftError);
  });
});

describe('the enterprise lock', () => {
  const current = { features: { instagram: true, appointments: true } };
  it('refuses any finite limit or a feature turned off, allows turning features on', () => {
    expect(() => assertPlanRules('enterprise', current, parsePlanDraft({ features: { instagram: true, appointments: true }, limits: { seats: 100 } })))
      .toThrow(expect.objectContaining({ code: 'plan_locked', status: 403 }));
    expect(() => assertPlanRules('enterprise', current, parsePlanDraft({ features: { instagram: true }, limits: {} })))
      .toThrow(expect.objectContaining({ code: 'plan_locked' }));
    expect(() => assertPlanRules('enterprise', current, parsePlanDraft({ features: { instagram: true, appointments: true, storefront: true }, limits: {} })))
      .not.toThrow();
    // Other plans may tighten.
    expect(() => assertPlanRules('pro', current, parsePlanDraft({ features: {}, limits: { seats: 1 } }))).not.toThrow();
  });

  it('is checked before the (potentially heavy) preview query', async () => {
    expect(await code(previewPlan('enterprise', { features: { instagram: true, appointments: true }, limits: { contacts: 10 } }))).toBe('plan_locked');
    expect(h.preview).not.toHaveBeenCalled();
  });
});

describe('preview and publish', () => {
  it('previews the normalised draft and publishes it with the echoed hash and the session email', async () => {
    await previewPlan('pro', { features: { instagram: true }, limits: { seats: 5 } });
    const [, features, limits] = h.preview.mock.calls[0];
    expect(await publishPlan(admin, 'pro', { features: { instagram: true }, limits: { seats: 5 }, note: ' tighten ', previewHash: HASH }))
      .toEqual({ version: 4 });
    expect(h.publish).toHaveBeenCalledWith({ planId: 'pro', features, limits, note: 'tighten', adminEmail: admin.email, previewHash: HASH });
  });

  it('refuses a missing or malformed preview hash, an over-long note and an unknown plan', async () => {
    expect(await code(publishPlan(admin, 'pro', { features: {}, limits: {} }))).toBe('invalid_request');
    expect(await code(publishPlan(admin, 'pro', { features: {}, limits: {}, previewHash: 'nope' }))).toBe('invalid_request');
    expect(await code(publishPlan(admin, 'pro', { features: {}, limits: {}, previewHash: HASH, note: 'x'.repeat(501) }))).toBe('invalid_request');
    expect(await code(publishPlan(admin, 'gold', { features: {}, limits: {}, previewHash: HASH }))).toBe('unknown_plan');
    expect(await code(publishPlan(admin, 'Robert); DROP', { features: {}, limits: {}, previewHash: HASH }))).toBe('unknown_plan');
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe('move subscribers', () => {
  it('needs a reason and the version the admin saw', async () => {
    expect(await code(moveSubscribers(admin, 'pro', { reason: 'short', version: 3 }))).toBe('reason_required');
    expect(await code(moveSubscribers(admin, 'pro', { reason: 'Align with the new pro terms', version: 2 }))).toBe('stale_version');
    expect(h.move).not.toHaveBeenCalled();
  });

  it('archives over-limit items for each moved workspace and lists any that failed', async () => {
    h.move.mockResolvedValue([{ accountId: 'a1', changed: true }, { accountId: 'a2', changed: true }, { accountId: 'a3', changed: true }]);
    h.enforce
      .mockResolvedValueOnce({ segments: { archived: 2, restored: 0 }, lists: { archived: 0, restored: 0 } })
      .mockResolvedValueOnce({ segments: { archived: 0, restored: 0 } })
      .mockRejectedValueOnce(new Error('db'));
    const result = await moveSubscribers(admin, 'pro', { reason: 'Align with the new pro terms', version: 3 });
    expect(h.move).toHaveBeenCalledWith('pro', 3, admin.email, 'Align with the new pro terms');
    expect(result).toEqual({ version: 3, moved: 3, archivedWorkspaces: 1, failedAccounts: ['a3'] });
  });

  it('re-runs the archive for workspaces an earlier move already pinned, counting only the new moves', async () => {
    h.move.mockResolvedValue([{ accountId: 'a1', changed: false }, { accountId: 'a2', changed: true }]);
    h.enforce.mockResolvedValue({ segments: { archived: 0, restored: 0 } });
    const result = await moveSubscribers(admin, 'pro', { reason: 'Align with the new pro terms', version: 3 });
    expect(h.enforce.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2']);
    expect(result.moved).toBe(1);
  });

  it('maps a publish that landed between the check and the move to stale_version', async () => {
    const { PlatformDbError } = await import('./db');
    h.move.mockRejectedValue(new PlatformDbError('stale_version'));
    expect(await code(moveSubscribers(admin, 'pro', { reason: 'Align with the new pro terms', version: 3 }))).toBe('stale_version');
    expect(h.enforce).not.toHaveBeenCalled();
  });
});
