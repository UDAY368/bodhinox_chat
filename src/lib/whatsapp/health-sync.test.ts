import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 'job-id'),
  numbers: [] as { account_id: string; whatsapp_config_id: string }[],
  workerQueries: 0,
}));
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: h.enqueue }));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({ $queryRaw: async () => { h.workerQueries += 1; return h.numbers; } }),
}));
// The fake transaction below stands in for withTenant's transaction.
let tx: FakeTx;
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (t: FakeTx) => Promise<unknown>) => op(tx),
}));
vi.mock('./encryption', () => ({ decrypt: () => 'plain-token' }));

import { MetaApiError } from './meta-api';
import {
  applyHealthSnapshot,
  categorizeHealthError,
  detectHealthChanges,
  healthSyncDedupeKey,
  HEALTH_SYNC_INTERVAL_MS,
  mergeSnapshot,
  normalizeStatus,
  notificationDedupeKey,
  resetHealthScheduleForTests,
  scheduleHealthSync,
  syncNumberHealth,
  type FetchedHealth,
  type HealthSnapshot,
} from './health-sync';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONFIG = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const blank: HealthSnapshot = { quality_rating: null, messaging_limit_tier: null, name_status: null, code_verification_status: null };
const snap = (s: Partial<HealthSnapshot>): HealthSnapshot => ({ ...blank, ...s });

/** An in-memory whatsapp_config row and notifications table with the real unique dedupe index. */
class FakeTx {
  row: Record<string, unknown> | null = {
    id: CONFIG, phone_number_id: '1555', access_token: 'enc', status: 'connected', display_name: 'Sales',
    ...blank, health_checked_at: null, health_error: null,
  };
  notifications = new Map<string, Record<string, unknown>>();
  admins = [ADMIN, OWNER];
  $queryRaw = async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    // createNotification's recipient lookup: members with their (default) preferences.
    if (sql.includes('LEFT JOIN notification_preferences'))
      return [...this.admins].sort().map((user_id) => ({ user_id, in_app: true, email: false }));
    if (sql.includes('FROM account_memberships')) return this.admins.map((user_id) => ({ user_id }));
    if (sql.includes('FROM whatsapp_config')) return this.row ? [{ ...this.row }] : [];
    throw new Error(`unexpected query ${sql}`);
  };
  $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('UPDATE whatsapp_config SET quality_rating')) {
      const [quality_rating, messaging_limit_tier, name_status, code_verification_status, health_checked_at] = values;
      Object.assign(this.row!, { quality_rating, messaging_limit_tier, name_status, code_verification_status, health_checked_at, health_error: null });
      return 1;
    }
    if (sql.includes("UPDATE whatsapp_config SET health_error='token'")) {
      Object.assign(this.row!, { health_error: 'token' });
      return 1;
    }
    if (sql.includes('UPDATE whatsapp_config SET health_error')) {
      Object.assign(this.row!, { health_error: values[0] });
      return 1;
    }
    if (sql.includes('INSERT INTO notifications')) {
      const [, , user_id, type, , , , , title, body, link, dedupe_key] = values as string[];
      expect(type).toBe('whatsapp_number_health');
      expect(link).toBe('/settings?tab=whatsapp');
      const key = `${user_id}|${dedupe_key}`;
      if (this.notifications.has(key)) return 0; // ON CONFLICT DO NOTHING
      this.notifications.set(key, { user_id, title, body, dedupe_key });
      return 1;
    }
    throw new Error(`unexpected statement ${sql}`);
  };
}

const fetched = (s: Partial<FetchedHealth>): FetchedHealth => ({ ...blank, display_phone_number: '+1 555 0100', ...s });

beforeEach(() => {
  vi.clearAllMocks();
  tx = new FakeTx();
  h.numbers = [];
  h.workerQueries = 0;
  resetHealthScheduleForTests();
});

describe('change detection', () => {
  it('alerts on quality drops only', () => {
    expect(detectHealthChanges(snap({ quality_rating: 'GREEN' }), snap({ quality_rating: 'YELLOW' }))).toEqual([{ kind: 'quality_drop', from: 'GREEN', to: 'YELLOW' }]);
    expect(detectHealthChanges(snap({ quality_rating: 'GREEN' }), snap({ quality_rating: 'RED' }))).toEqual([{ kind: 'quality_drop', from: 'GREEN', to: 'RED' }]);
    expect(detectHealthChanges(snap({ quality_rating: 'YELLOW' }), snap({ quality_rating: 'RED' }))).toHaveLength(1);
    expect(detectHealthChanges(snap({ quality_rating: 'RED' }), snap({ quality_rating: 'GREEN' }))).toEqual([]);
    expect(detectHealthChanges(snap({ quality_rating: 'YELLOW' }), snap({ quality_rating: 'YELLOW' }))).toEqual([]);
    expect(detectHealthChanges(snap({ quality_rating: 'UNKNOWN' }), snap({ quality_rating: 'RED' }))).toEqual([]);
  });

  it('alerts on any tier change but not on the first observation', () => {
    expect(detectHealthChanges(snap({ messaging_limit_tier: 'TIER_1K' }), snap({ messaging_limit_tier: 'TIER_10K' }))).toEqual([{ kind: 'tier_change', from: 'TIER_1K', to: 'TIER_10K' }]);
    expect(detectHealthChanges(snap({ messaging_limit_tier: 'TIER_10K' }), snap({ messaging_limit_tier: 'TIER_1K' }))).toHaveLength(1);
    expect(detectHealthChanges(blank, snap({ messaging_limit_tier: 'TIER_1K', quality_rating: 'RED' }))).toEqual([]);
  });

  it('alerts when the display name is newly rejected', () => {
    expect(detectHealthChanges(snap({ name_status: 'PENDING_REVIEW' }), snap({ name_status: 'DECLINED' }))).toEqual([{ kind: 'name_rejected', from: 'PENDING_REVIEW', to: 'DECLINED' }]);
    expect(detectHealthChanges(blank, snap({ name_status: 'DECLINED' }))).toHaveLength(1);
    expect(detectHealthChanges(snap({ name_status: 'DECLINED' }), snap({ name_status: 'DECLINED' }))).toEqual([]);
    expect(detectHealthChanges(snap({ name_status: 'PENDING_REVIEW' }), snap({ name_status: 'APPROVED' }))).toEqual([]);
  });

  it('keeps stored values Meta did not return, and only accepts enum-shaped values', () => {
    expect(mergeSnapshot(snap({ messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED' }), snap({ quality_rating: 'GREEN' })))
      .toEqual(snap({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED' }));
    expect(normalizeStatus(' green ')).toBe('GREEN');
    expect(normalizeStatus('<script>')).toBeNull();
    expect(normalizeStatus(42)).toBeNull();
  });

  it('classifies Meta failures without keeping their message', () => {
    expect(categorizeHealthError(new MetaApiError('Invalid OAuth access token', { code: 190, httpStatus: 400 }))).toBe('token');
    expect(categorizeHealthError(new MetaApiError('x', { httpStatus: 500 }))).toBe('unavailable');
    expect(categorizeHealthError(new TypeError('fetch failed'))).toBe('unavailable');
  });
});

describe('applyHealthSnapshot', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const apply = (f: Partial<FetchedHealth>, at = now) =>
    applyHealthSnapshot(tx as never, { accountId: ACCOUNT, configId: CONFIG, fetched: fetched(f), now: at });

  it('stores the first snapshot without alerting anyone', async () => {
    const result = await apply({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED', code_verification_status: 'VERIFIED' });
    expect(result).toMatchObject({ status: 'synced', changes: [], notified: 0 });
    expect(tx.row).toMatchObject({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', code_verification_status: 'VERIFIED', health_checked_at: now });
    expect(tx.notifications.size).toBe(0);
  });

  it('notifies every owner and admin once per change, and a re-run adds nothing', async () => {
    await apply({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' });
    const later = new Date(now.getTime() + HEALTH_SYNC_INTERVAL_MS);
    const first = await apply({ quality_rating: 'RED', messaging_limit_tier: 'TIER_10K' }, later);
    expect(first).toMatchObject({ notified: 4 });
    expect(first && first.changes.map((c) => c.kind)).toEqual(['quality_drop', 'tier_change']);
    const bodies = [...tx.notifications.values()];
    expect(new Set(bodies.map((n) => n.user_id))).toEqual(new Set([ADMIN, OWNER]));
    expect(bodies.find((n) => n.title === 'WhatsApp number quality dropped')?.body).toContain('Sales: quality rating went from GREEN to RED');
    expect(bodies.find((n) => n.title === 'WhatsApp messaging limit changed')?.body).toContain('1,000 per day to 10,000 per day');
    // The same answer again (a retry, or the next cycle) is no change.
    const again = await apply({ quality_rating: 'RED', messaging_limit_tier: 'TIER_10K' }, new Date(later.getTime() + 1));
    expect(again).toMatchObject({ changes: [], notified: 0 });
    expect(tx.notifications.size).toBe(4);
  });

  it('dedupes a replayed insert for the same observed change', async () => {
    await apply({ quality_rating: 'GREEN' });
    const checkedAt = tx.row!.health_checked_at as Date;
    const later = new Date(now.getTime() + 1000);
    await apply({ quality_rating: 'YELLOW' }, later);
    // Simulate a transaction that saw the same stored row (e.g. replay before commit).
    Object.assign(tx.row!, { quality_rating: 'GREEN', health_checked_at: checkedAt });
    const replay = await apply({ quality_rating: 'YELLOW' }, later);
    expect(replay).toMatchObject({ notified: 0 });
    expect(tx.notifications.size).toBe(2);
    expect([...tx.notifications.values()][0].dedupe_key).toBe(
      notificationDedupeKey(CONFIG, { kind: 'quality_drop', from: 'GREEN', to: 'YELLOW' }, checkedAt)
    );
  });

  it('alerts again if quality recovers and then drops again', async () => {
    await apply({ quality_rating: 'GREEN' }, new Date(1000));
    await apply({ quality_rating: 'YELLOW' }, new Date(2000));
    await apply({ quality_rating: 'GREEN' }, new Date(3000));
    await apply({ quality_rating: 'YELLOW' }, new Date(4000));
    expect(tx.notifications.size).toBe(4);
  });

  it('falls back to the phone number when the number has no name', async () => {
    tx.row!.display_name = null;
    await apply({ name_status: 'PENDING_REVIEW' });
    await apply({ name_status: 'DECLINED' }, new Date(now.getTime() + 1));
    expect([...tx.notifications.values()][0]).toMatchObject({ title: 'WhatsApp display name rejected' });
    expect(String([...tx.notifications.values()][0].body)).toMatch(/^\+1 555 0100:/);
  });

  it('returns null for a number that is not in the workspace', async () => {
    tx.row = null;
    expect(await apply({ quality_rating: 'GREEN' })).toBeNull();
  });
});

describe('syncNumberHealth', () => {
  it('records a Meta failure as a category, keeps the last good health, and does not throw', async () => {
    Object.assign(tx.row!, { quality_rating: 'GREEN', health_checked_at: new Date(1) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchHealth = vi.fn(async () => { throw new MetaApiError('Error validating access token: secret details', { code: 190, httpStatus: 401 }); });
    const result = await syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, fetchHealth, db: {} as never });
    expect(result).toEqual({ status: 'error', error: 'token' });
    expect(fetchHealth).toHaveBeenCalledWith({ phoneNumberId: '1555', accessToken: 'plain-token' });
    expect(tx.row).toMatchObject({ health_error: 'token', quality_rating: 'GREEN', health_checked_at: new Date(1) });
    // The first token error alerts the owner and admin once; a repeat (already 'token') adds nothing.
    expect([...tx.notifications.values()].map((n) => n.title)).toEqual(['WhatsApp number needs reconnecting', 'WhatsApp number needs reconnecting']);
    await syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, fetchHealth, db: {} as never });
    expect(tx.notifications.size).toBe(2);
    // Logs carry neither the token nor Meta's message.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/plain-token|secret details/);
    warn.mockRestore();
  });

  it('skips disconnected and unknown numbers without calling Meta', async () => {
    const fetchHealth = vi.fn();
    tx.row!.status = 'disconnected';
    expect(await syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, fetchHealth, db: {} as never })).toEqual({ status: 'disconnected' });
    expect(await syncNumberHealth({ accountId: ACCOUNT, configId: 'not-a-uuid', fetchHealth, db: {} as never })).toEqual({ status: 'not_found' });
    tx.row = null;
    expect(await syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, fetchHealth, db: {} as never })).toEqual({ status: 'not_found' });
    expect(fetchHealth).not.toHaveBeenCalled();
  });

  it('refuses a tenant context for another workspace', async () => {
    await expect(syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, tenant: { accountId: OWNER, role: 'admin' }, db: {} as never }))
      .rejects.toThrow('tenant mismatch');
  });

  it('stores fresh health and clears the last error', async () => {
    tx.row!.health_error = 'unavailable';
    const fetchHealth = vi.fn(async () => fetched({ quality_rating: 'GREEN' }));
    const result = await syncNumberHealth({ accountId: ACCOUNT, configId: CONFIG, fetchHealth, db: {} as never });
    expect(result).toMatchObject({ status: 'synced' });
    expect(tx.row).toMatchObject({ quality_rating: 'GREEN', health_error: null });
  });
});

describe('scheduleHealthSync', () => {
  const A2 = '55555555-5555-4555-8555-555555555555';
  it('queues one deduplicated job per connected number per six-hour window', async () => {
    h.numbers = [{ account_id: ACCOUNT, whatsapp_config_id: CONFIG }, { account_id: ACCOUNT, whatsapp_config_id: A2 }];
    const now = 10 * HEALTH_SYNC_INTERVAL_MS + 5;
    expect(await scheduleHealthSync(now)).toBe(2);
    expect(h.enqueue).toHaveBeenCalledWith('whatsapp.health_sync', { configId: CONFIG },
      { tenantId: ACCOUNT, dedupeKey: `whatsapp-health:${CONFIG}:10`, maxAttempts: 3 });
    expect(h.enqueue).toHaveBeenCalledWith('whatsapp.health_sync', { configId: A2 }, expect.objectContaining({ dedupeKey: `whatsapp-health:${A2}:10` }));
    expect(healthSyncDedupeKey(CONFIG, now + HEALTH_SYNC_INTERVAL_MS - 10)).toBe(`whatsapp-health:${CONFIG}:10`);
    expect(healthSyncDedupeKey(CONFIG, 11 * HEALTH_SYNC_INTERVAL_MS)).toBe(`whatsapp-health:${CONFIG}:11`);
  });

  it('looks for numbers at most every ten minutes', async () => {
    const now = 10 * HEALTH_SYNC_INTERVAL_MS;
    await scheduleHealthSync(now);
    await scheduleHealthSync(now + 30_000);
    expect(h.workerQueries).toBe(1);
    await scheduleHealthSync(now + 10 * 60_000);
    expect(h.workerQueries).toBe(2);
  });
});
