import { describe, it, expect, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import {
  createBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
} from './broadcast-core';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// The create transaction: `tx.createRows` is what the atomic
// create_broadcast_with_recipients call returns (or throws), and every
// statement is recorded so tests can see the job commit alongside it.
const tx = {
  createRows: [] as unknown[] | Error,
  statements: [] as string[],
  $queryRaw(strings: TemplateStringsArray) {
    tx.statements.push(strings.join('?'));
    return tx.createRows instanceof Error ? Promise.reject(tx.createRows) : Promise.resolve(tx.createRows);
  },
  $executeRaw(strings: TemplateStringsArray) {
    tx.statements.push(strings.join('?'));
    return Promise.resolve(1);
  },
};
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
const sendRoom = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}));
vi.mock('@/lib/billing/limits', () => ({ requireCampaignSendRoom: sendRoom }));
const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_context: unknown, operation: (t: typeof tx) => Promise<unknown>) => operation(tx),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as DataClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into the create transaction.
function makeDb(
  createRows: unknown[] | Error,
  numbers: Record<string, unknown>[] = [{ phone_number_id: 'pn-1', access_token: 'enc' }],
  templates: Record<string, unknown>[] = []
) {
  tx.createRows = createRows;
  tx.statements = [];
  const calls = {
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        const filters: Record<string, unknown> = {};
        const match = () => numbers.filter((n) => Object.entries(filters).every(([k, v]) => k === 'account_id' || n[k] === v));
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (field: string, value: unknown) => {
            filters[field] = value;
            return chain;
          },
          maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: match(), error: null }),
        };
        return chain;
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: templates, error: null }),
        };
        return chain;
      }
      if (table === 'contacts') {
        // Consent lookup: nobody is opted out or blocked in these tests.
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => Promise.resolve({ data: [], error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as DataClient;
  return { db: database, calls };
}

describe('createBroadcast recipient validation (#586)', () => {
  it('counts a recipient without a leading + as rejected instead of sending it abroad', async () => {
    const { db } = makeDb([{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }]);

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [
        { to: '4155551212' }, // US national → Meta would read +41 (Switzerland)
        { to: '14155550123' }, // country code but no + — indistinguishable
        { to: '+14155550123' },
      ],
    });

    expect(plan.rejected).toBe(2);
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [], contactId: 'c1' },
    ]);
  });

  it('fails the whole request when no recipient carries a country code', async () => {
    const { db } = makeDb([]);
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '4155551212' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(tx.statements).toHaveLength(0);
  });
});

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent, recipients and the dispatch job in one transaction, never a bare parent insert', async () => {
    const { db, calls } = makeDb([{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }]);

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    // The plan read comes first; then the atomic create and its dispatch job.
    expect(tx.statements).toHaveLength(3);
    expect(tx.statements[0]).toContain('account_subscriptions');
    expect(tx.statements[1]).toContain('create_broadcast_with_recipients');
    expect(tx.statements[2]).toContain("'broadcast.dispatch'");
    // The month's message and active-contact allowance is checked in the same transaction (audit finding 41).
    expect(sendRoom).toHaveBeenCalledWith(tx, 'acc', 1);
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [], contactId: 'c1' },
    ]);
  });

  it('throws and leaves no orphaned parent or job when the atomic create fails', async () => {
    const { db, calls } = makeDb(new Error('recipient insert failed'));

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The create was the only statement; its failure rolls the whole
    // transaction back, so no parent or job can survive as an orphan.
    expect(tx.statements).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

describe('createBroadcast — two numbers in one workspace', () => {
  const A = '11111111-1111-4111-8111-11111111111a';
  const B = '22222222-2222-4222-8222-22222222222b';
  const NUMBERS = [
    { id: A, phone_number_id: '1000', access_token: 'enc', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    { id: B, phone_number_id: '2000', access_token: 'enc', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
  ];
  const ROWS = [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }];
  const recipients = [{ to: '+14155550123' }];

  it('stores and sends from the default number when none is named', async () => {
    const { db } = makeDb(ROWS, NUMBERS);
    const plan = await createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients });
    expect(plan.phoneNumberId).toBe('1000');
    expect(tx.statements.some((st) => st.includes('UPDATE broadcasts SET whatsapp_config_id'))).toBe(true);
  });

  it('sends from the number named by phone_number_id', async () => {
    const { db } = makeDb(ROWS, NUMBERS);
    const plan = await createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients, phoneNumberId: '2000' });
    expect(plan.phoneNumberId).toBe('2000');
  });

  it('refuses a number that is not connected to the workspace before creating anything', async () => {
    const { db } = makeDb(ROWS, NUMBERS);
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients, phoneNumberId: '9999' })
    ).rejects.toMatchObject({ code: 'whatsapp_number_unavailable', status: 400 });
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients, whatsappConfigId: '33333333-3333-4333-8333-333333333333' })
    ).rejects.toMatchObject({ code: 'whatsapp_number_unavailable', status: 400 });
    expect(tx.statements).toHaveLength(0);
  });

  it("refuses a template from another number's WABA", async () => {
    const { db } = makeDb(ROWS, NUMBERS, [{ id: 't', user_id: 'u', name: 'promo', category: 'Marketing', language: 'en_US', body_text: 'Hi', created_at: '2026-01-01T00:00:00Z', waba_id: 'waba-a' }]);
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients, whatsappConfigId: B })
    ).rejects.toMatchObject({ code: 'template_wrong_number', status: 422 });
    expect(tx.statements).toHaveLength(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
  transitioned: Record<string, unknown>[] = [],
) {
  return {
    from(table: string) {
      let status: string | null = null;
      let updating = false;
      const b: Record<string, unknown> = {
        select: () => b,
        neq: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          updating = true;
          return b;
        },
        then: (resolve: (r: { count: number; data: unknown; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            data: updating ? transitioned : null,
            error: null,
          }),
      };
      return b;
    },
  } as unknown as DataClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('emits broadcast.completed only when the status actually transitions', async () => {
    webhook.dispatch.mockClear();
    await finalizeBroadcastStatus(statusDb({ pending: 0 }, 10, {}), 'b-1');
    expect(webhook.dispatch).not.toHaveBeenCalled();

    const row = { id: 'b-1', account_id: 'acc', name: 'July', status: 'sent', total_recipients: 10, sent_count: 10, delivered_count: 9, read_count: 4, replied_count: 1, failed_count: 0 };
    await finalizeBroadcastStatus(statusDb({ pending: 0 }, 10, {}, [row]), 'b-1');
    expect(webhook.dispatch).toHaveBeenCalledWith(expect.anything(), 'acc', 'broadcast.completed', expect.objectContaining({ broadcast_id: 'b-1', status: 'sent', delivered: 9 }));
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});
