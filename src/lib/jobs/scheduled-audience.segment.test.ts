/**
 * Phase 12 scheduled audiences: a saved segment is resolved at each
 * occurrence (dynamic), opted-out members are skipped, once_per_contact
 * skips contacts this automation already ran for (before the row cap), and
 * the segment's references and plan gate are checked like a campaign's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

type Row = { id: string; opted_out_at?: string | null; blocked_at?: string | null };
const h = vi.hoisted(() => ({
  segmentRows: [] as Array<{ id: string; opted_out_at?: string | null; blocked_at?: string | null }>,
  segmentMissing: false,
  filter: { conditions: [{ field: 'name', op: 'is_not_empty' }] } as Record<string, unknown>,
  retargetingOff: false,
  alreadyRun: [] as string[],
  queries: [] as string[],
  enqueue: vi.fn(),
  trigger: vi.fn(async () => undefined),
  dispatchKeys: [] as string[],
  updates: [] as Array<{ table: string; values: unknown }>,
}));

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.trigger }));
vi.mock('./dispatch', () => ({
  dispatchOnce: async (_a: string, key: string, work: () => Promise<unknown>) => { h.dispatchKeys.push(key); return work(); },
}));
vi.mock('./queue', () => ({ enqueueJob: h.enqueue }));
vi.mock('@/lib/broadcast-audience', () => ({ resolveAudienceContacts: vi.fn(async () => []) }));
vi.mock('@/lib/billing/entitlements', () => {
  class PlanLimitError extends Error {}
  return {
    PlanLimitError,
    requireFeature: async (_tx: unknown, _acc: string, feature: string) => {
      if (feature === 'retargeting' && h.retargetingOff) throw new PlanLimitError('Retargeting is not on your plan');
    },
    requireWithinLimit: async () => {},
  };
});
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => Promise<unknown>) =>
    op({
      $queryRaw: async (first: TemplateStringsArray | { sql: string }) => {
        const sql = 'sql' in first ? first.sql : first.join('?');
        h.queries.push(sql);
        // Referenced rows that still exist: none (the tag was deleted).
        if (/FROM (tags|contact_lists|custom_fields|broadcasts)\b/.test(sql)) return [];
        if (sql.includes('FROM contacts c')) {
          // What the SQL leaves out: opted-out and blocked contacts, and (with the NOT EXISTS) contacts that already ran.
          const fresh = (r: Row) => !r.opted_out_at && !r.blocked_at && !(sql.includes('NOT EXISTS') && h.alreadyRun.includes(r.id));
          // LIMIT MAX_SCHEDULED_CONTACTS + 1 (1000 + 1).
          return h.segmentRows.filter(fresh).slice(0, 1001).map((r) => ({ id: r.id }));
        }
        return h.alreadyRun.map((contact_id) => ({ contact_id }));
      },
    }),
}));
vi.mock('@/lib/audience/segments', async () => {
  const { AudienceFilterError } = await import('@/lib/audience/filter');
  return {
    loadSegmentFilter: async (_tx: unknown, _acc: string, _id: string, options: { lock?: boolean }) => {
      if (!options?.lock) throw new Error('segment must be read with the plan-archive check');
      if (h.segmentMissing) throw new AudienceFilterError('Segment is unavailable in this workspace');
      return h.filter;
    },
  };
});

import { executeScheduledOccurrence, queueScheduledOccurrence } from './scheduled-audience';
import { MAX_SCHEDULED_CONTACTS } from '@/lib/automations/scheduled-contract';

const ACC = '00000000-0000-4000-8000-0000000000a1';
const SEG = '00000000-0000-4000-8000-000000000051';
const TAG = '00000000-0000-4000-8000-000000000071';
const CAMPAIGN = '00000000-0000-4000-8000-000000000081';
const SLOT = '2026-11-10T09:00:00.000Z';

function db(triggerConfig: Record<string, unknown> = {}): DataClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let mode = 'select';
      for (const m of ['select', 'eq', 'order', 'limit', 'in']) b[m] = () => b;
      b.update = (values: unknown) => { mode = 'update'; h.updates.push({ table, values }); return b; };
      b.insert = (values: unknown) => { h.updates.push({ table, values }); return Promise.resolve({ data: null, error: null }); };
      const result = () => {
        if (mode === 'update') return { data: [{ id: 'auto', user_id: 'u' }], error: null };
        if (table === 'automation_steps') return { data: [{ step_type: 'add_tag', step_config: { tag_id: 't' } }], error: null };
        if (table === 'automations') return { data: { id: 'auto', user_id: 'u', is_active: true, trigger_type: 'time_based', trigger_config: triggerConfig }, error: null };
        if (table === 'contacts') return { data: { id: 'c1', phone: '+14155550101', wa_user_id: null }, error: null };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => result();
      b.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return b;
    },
  } as unknown as DataClient;
}

const queued = () => h.enqueue.mock.calls.map((c) => (c[1] as { contactId?: string }).contactId);
const memberQuery = () => h.queries.find((q) => q.includes('FROM contacts c')) ?? '';

beforeEach(() => {
  h.segmentRows = [
    { id: 'c1', opted_out_at: null, blocked_at: null },
    { id: 'c2', opted_out_at: '2026-11-01T00:00:00Z', blocked_at: null },
    { id: 'c3', opted_out_at: null, blocked_at: '2026-11-01T00:00:00Z' },
    { id: 'c4', opted_out_at: null, blocked_at: null },
  ];
  h.segmentMissing = false;
  h.filter = { conditions: [{ field: 'name', op: 'is_not_empty' }] };
  h.retargetingOff = false;
  h.alreadyRun = [];
  h.queries = [];
  h.dispatchKeys = [];
  h.updates = [];
  h.enqueue.mockClear();
  h.trigger.mockClear();
});

describe('segment audience', () => {
  const automation = (extra: Record<string, unknown> = {}) => ({
    id: 'auto',
    trigger_config: { schedule: '0 9 * * *', audience: { type: 'segment', segmentId: SEG }, ...extra },
  });

  it('queues the segment members found now, leaving out opted-out and blocked contacts in SQL', async () => {
    await queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {});
    expect(queued()).toEqual(['c1', 'c4']);
    expect(memberQuery()).toMatch(/c\.opted_out_at IS NULL AND c\.blocked_at IS NULL/);
    expect(h.enqueue.mock.calls[0][2]).toEqual({ tenantId: ACC, dedupeKey: `trigger:auto:${SLOT}:c1` });
  });

  it('is dynamic: the next occurrence sees the new membership', async () => {
    await queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {});
    h.segmentRows = [{ id: 'c9', opted_out_at: null, blocked_at: null }];
    await queueScheduledOccurrence(db(), ACC, automation(), '2026-11-11T09:00:00.000Z', () => {});
    expect(queued()).toEqual(['c1', 'c4', 'c9']);
  });

  it('refuses a missing or archived segment and more than the scheduled limit, queueing nothing', async () => {
    h.segmentMissing = true;
    await expect(queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {})).rejects.toThrow(/segment/);
    h.segmentMissing = false;
    h.segmentRows = Array.from({ length: MAX_SCHEDULED_CONTACTS + 1 }, (_, i) => ({ id: `c${i}` }));
    await expect(queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {})).rejects.toThrow(/limit/);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a segment whose has_none tag was deleted, instead of matching everyone', async () => {
    h.filter = { conditions: [{ field: 'tags', op: 'has_none', tagIds: [TAG] }] };
    await expect(queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {})).rejects.toThrow(/segment/);
    expect(h.queries.some((q) => q.includes('FROM tags'))).toBe(true);
    expect(memberQuery()).toBe('');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('turns the schedule off once when a retargeting segment is no longer on the plan', async () => {
    h.filter = { conditions: [{ field: 'campaign', broadcastId: CAMPAIGN, op: 'delivered' }] };
    h.retargetingOff = true;
    await queueScheduledOccurrence(db(), ACC, automation(), SLOT, () => {});
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.updates).toContainEqual({ table: 'automations', values: { is_active: false } });
    expect(h.updates.some((u) => u.table === 'automation_logs')).toBe(true);
  });

  it('once_per_contact leaves out contacts this automation already ran for, in SQL', async () => {
    h.alreadyRun = ['c1'];
    await queueScheduledOccurrence(db(), ACC, automation({ once_per_contact: true }), SLOT, () => {});
    expect(queued()).toEqual(['c4']);
    expect(memberQuery()).toMatch(/NOT EXISTS \(SELECT 1 FROM automation_logs/);
  });

  it('applies the row cap after once_per_contact, so a grown drip segment still enrolls its new members', async () => {
    h.segmentRows = Array.from({ length: 1050 }, (_, i) => ({ id: `m${i}` }));
    h.alreadyRun = h.segmentRows.slice(0, 1040).map((r) => r.id);
    await queueScheduledOccurrence(db(), ACC, automation({ once_per_contact: true }), SLOT, () => {});
    expect(queued()).toHaveLength(10);
  });
});

describe('once_per_contact at execution', () => {
  it('skips a contact that an earlier occurrence already ran for', async () => {
    h.alreadyRun = ['c1'];
    await executeScheduledOccurrence(db({ once_per_contact: true }), ACC, 'auto', SLOT, 'c1', () => {});
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it('runs when the contact has no earlier run, and never checks without the option', async () => {
    await executeScheduledOccurrence(db({ once_per_contact: true }), ACC, 'auto', SLOT, 'c1', () => {});
    expect(h.trigger).toHaveBeenCalledTimes(1);
    h.queries = [];
    await executeScheduledOccurrence(db(), ACC, 'auto', SLOT, 'c1', () => {});
    expect(h.queries).toEqual([]);
  });

  it('fences a once-only run per contact, not per slot, so two occurrences share one dispatch intent', async () => {
    await executeScheduledOccurrence(db({ once_per_contact: true }), ACC, 'auto', SLOT, 'c1', () => {});
    await executeScheduledOccurrence(db({ once_per_contact: true }), ACC, 'auto', '2026-11-10T09:15:00.000Z', 'c1', () => {});
    expect(h.dispatchKeys).toEqual(['scheduled-once:auto:c1', 'scheduled-once:auto:c1']);
    await executeScheduledOccurrence(db(), ACC, 'auto', SLOT, 'c1', () => {});
    expect(h.dispatchKeys[2]).toBe(`scheduled:auto:${SLOT}:c1`);
  });
});
