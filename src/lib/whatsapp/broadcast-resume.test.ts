import { describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

import { BroadcastError, UNCERTAIN_SEND_MESSAGE } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): DataClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as DataClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  recipientCount?: number;
  config?: Record<string, unknown> | null;
  /** Several numbers in the workspace (overrides `config`). */
  configs?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedIdBatches?: unknown[];
  failedUpdate?: Record<string, unknown>;
  /** `.is()` filters on the recipient read (uncertain rows are left out). */
  isFilters?: Record<string, unknown>;
  /** The update that flags legacy uncertain rows, with its filters. */
  legacyFlag?: { filters: Record<string, unknown>; is: Record<string, unknown> };
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): DataClient {
  const configs = fx.configs ?? (fx.config ? [fx.config] : []);
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const isFilters: Record<string, unknown> = {};
      let flagging = false;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return b;
        },
        is: (col: string, val: unknown) => {
          isFilters[col] = val;
          if (flagging) writes.legacyFlag = { filters, is: isFilters };
          else if (table === 'broadcast_recipients') writes.isFilters = isFilters;
          return b;
        },
        order: () => b,
        range: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') {
            writes.failedIds = vals;
            writes.failedIdBatches = [...(writes.failedIdBatches ?? []), vals];
          }
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (Object.keys(row).join() === 'outcome_uncertain_at') flagging = true;
          else writes.failedUpdate = row;
          return b;
        },
        maybeSingle: async () => ({
          data: table === 'whatsapp_config'
            ? configs.find((c) => c.id === filters.id) ?? null
            : fx.broadcast === undefined ? null : fx.broadcast,
          error: null,
        }),
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
        then: (
          resolve: (r: { data: unknown[]; count?: number; error: null }) => unknown,
        ) => {
          if (table === 'broadcast_recipients') {
            return resolve({
              data: fx.recipients ?? [],
              count: fx.recipientCount,
              error: null,
            });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          if (table === 'whatsapp_config') {
            return resolve({ data: configs, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as DataClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
        clickToken: null,
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
        clickToken: null,
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('fails recipients who opted out or were blocked after creation, with the reason', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            { ...recipient('r2', '+15559876543'), contact: { phone: '+15559876543', opted_out_at: '2026-11-01T00:00:00Z' } },
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(unsendable).toBe(1);
    expect(writes.failedIds).toEqual(['r2']);
    expect(writes.failedUpdate).toEqual({ status: 'failed', error_message: 'Contact opted out' });
    expect(plan.planned.map((p) => p.recipientRowId)).toEqual(['r1']);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('counts the backlog the 1000-row page did not load', async () => {
    const firstPage = Array.from({ length: RESUME_MAX_PER_REQUEST }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: firstPage,
        recipientCount: 2812,
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    expect(remaining).toBe(2812 - RESUME_MAX_PER_REQUEST);
  });

  it('stamps many unsendable rows in URL-sized batches', async () => {
    const writes: PlanWrites = {};
    const rows = [
      recipient('ok', '+15551234567'),
      ...Array.from({ length: 250 }, (_, i) => recipient(`bad${i}`, null)),
    ];
    const { unsendable } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: rows }, writes),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(unsendable).toBe(250);
    const batches = (writes.failedIdBatches ?? []) as string[][];
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toHaveLength(250);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        config: CONFIG,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});

describe('planBroadcastResume: retries and uncertain sends (audit findings 11, 12)', () => {
  it('leaves uncertain sends out of every pass, and flags legacy ones before a retry', async () => {
    const writes: PlanWrites = {};
    await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+15551234567')] }, writes),
      'acct-1', 'bc-1', 'failed',
    );
    expect(writes.isFilters).toEqual({ outcome_uncertain_at: null });
    // Rows from before the flag existed carry only the error text.
    expect(writes.legacyFlag?.filters).toMatchObject({
      broadcast_id: 'bc-1', status: 'failed', error_message: UNCERTAIN_SEND_MESSAGE,
    });

    const pending: PlanWrites = {};
    await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+15551234567')] }, pending),
      'acct-1', 'bc-1', 'pending',
    );
    expect(pending.isFilters).toEqual({ outcome_uncertain_at: null });
    expect(pending.legacyFlag).toBeUndefined();
  });

  it('carries the retry generation and the message id already on the row into the plan', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          { ...recipient('r1', '+15551234567'), retry_generation: 2, whatsapp_message_id: null },
          { ...recipient('r2', '+15559876543'), retry_generation: 0, whatsapp_message_id: 'wamid.OLD' },
        ],
      }),
      'acct-1', 'bc-1', 'failed',
    );
    expect(plan.planned[0]).toMatchObject({ recipientRowId: 'r1', retryGeneration: 2 });
    expect(plan.planned[0]).not.toHaveProperty('previousMessageId');
    expect(plan.planned[1]).toMatchObject({ recipientRowId: 'r2', previousMessageId: 'wamid.OLD' });
    expect(plan.planned[1]).not.toHaveProperty('retryGeneration');
  });
});

describe('planBroadcastResume — two numbers in one workspace', () => {
  const A = '11111111-1111-4111-8111-11111111111a';
  const B = '22222222-2222-4222-8222-22222222222b';
  const NUMBERS = [
    { id: A, phone_number_id: 'pn-default', access_token: 'tok-a', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    { id: B, phone_number_id: 'pn-second', access_token: 'tok-b', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
  ];
  const ROWS = [recipient('r-1', '+15551230001')];

  it("sends from the campaign's number", async () => {
    const { plan } = await planBroadcastResume(
      planDb({ broadcast: { ...BROADCAST, whatsapp_config_id: B }, configs: NUMBERS, recipients: ROWS }),
      'acct-1', 'bc-1', 'pending'
    );
    expect(plan.phoneNumberId).toBe('pn-second');
    expect(plan.accessToken).toBe('decrypted:tok-b');
  });

  it('uses the default number for a campaign without one', async () => {
    const { plan } = await planBroadcastResume(
      planDb({ broadcast: { ...BROADCAST, whatsapp_config_id: null }, configs: [NUMBERS[1], NUMBERS[0]], recipients: ROWS }),
      'acct-1', 'bc-1', 'pending'
    );
    expect(plan.phoneNumberId).toBe('pn-default');
  });

  it("refuses a template from another number's WABA", async () => {
    const error = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, whatsapp_config_id: B },
        configs: NUMBERS,
        recipients: ROWS,
        templates: [{ id: 't-1', user_id: 'u', name: 'order_update', category: 'Utility', language: 'en_US', body_text: 'Hi {{1}}', created_at: '2026-01-01T00:00:00Z', waba_id: 'waba-a' }],
      }),
      'acct-1', 'bc-1', 'pending'
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BroadcastError);
    expect(error).toMatchObject({ code: 'template_wrong_number', status: 422 });
  });
});
