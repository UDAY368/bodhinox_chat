import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(async () => ({ inApp: ['u'], emailQueued: [] as string[] })),
  answers: [] as unknown[][],
  queries: [] as { sql: string; values: unknown[] }[],
  failTenant: false,
}));
vi.mock('@/lib/inbox/notify', () => ({ createNotification: h.create }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.queries.push({ sql: strings.join('?'), values });
    return h.answers.shift() ?? [];
  },
};
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (t: typeof tx) => Promise<unknown>) => {
    if (h.failTenant) throw new Error('database unavailable');
    return op(tx);
  },
}));

import {
  ASSIGNED_MESSAGE_DEBOUNCE_MINUTES,
  describeFinishedCampaign,
  notifyAssignedMessage,
  notifyCampaignFinished,
  notifyTemplateRejected,
} from './emit';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const MSG = '55555555-5555-4555-8555-555555555555';
const BROADCAST = '66666666-6666-4666-8666-666666666666';
const TEMPLATE = '77777777-7777-4777-8777-777777777777';
const EVENT = '88888888-8888-4888-8888-888888888888';
const input = { accountId: ACCOUNT, conversationId: CONV, contactId: CONTACT, messageId: MSG };

beforeEach(() => {
  vi.clearAllMocks();
  h.answers = [];
  h.queries = [];
  h.failTenant = false;
});

describe('notifyAssignedMessage', () => {
  it('does nothing for an unassigned conversation', async () => {
    h.answers = [[{ assignee: null }]];
    await notifyAssignedMessage(tx as never, input);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.queries).toHaveLength(1);
  });

  it('alerts the assignee with a link and no message content', async () => {
    h.answers = [[{ assignee: AGENT }], [{ recent: false }]];
    await notifyAssignedMessage(tx as never, input);
    expect(h.create).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT, userIds: [AGENT], event: 'assigned_message',
      title: 'New message in a conversation assigned to you',
      link: `/inbox?c=${CONV}`, dedupeKey: `assigned-message:${CONV}:${MSG}`,
      conversationId: CONV, contactId: CONTACT,
    });
    const [[, payload]] = h.create.mock.calls as unknown as [[unknown, Record<string, unknown>]];
    expect(payload).not.toHaveProperty('body');
  });

  it('debounces: an alert in the last few minutes (in-app or email) suppresses another', async () => {
    h.answers = [[{ assignee: AGENT }], [{ recent: true }]];
    await notifyAssignedMessage(tx as never, input);
    expect(h.create).not.toHaveBeenCalled();
    const check = h.queries[1];
    expect(check.sql).toContain('FROM notifications');
    expect(check.sql).toContain('FROM notification_email_queue');
    expect(check.values).toContain(ASSIGNED_MESSAGE_DEBOUNCE_MINUTES);
    expect(check.values).toContain(`assigned-message:${CONV}:`);
  });
});

describe('notifyCampaignFinished', () => {
  const row = { id: BROADCAST, account_id: ACCOUNT, name: 'Diwali', status: 'sent', sent_count: 98, failed_count: 2, total_recipients: 100 };

  it('describes the outcome from counts only', () => {
    expect(describeFinishedCampaign(row)).toEqual({ title: 'Campaign "Diwali" finished', body: '98 sent, 2 failed of 100 recipients.' });
    expect(describeFinishedCampaign({ ...row, status: 'failed', name: '' }).title).toBe('Campaign "Your campaign" failed');
  });

  it('alerts the creator when they are still a member', async () => {
    h.answers = [[{ user_id: AGENT }]];
    await notifyCampaignFinished(row);
    expect(h.create).toHaveBeenCalledWith(tx, expect.objectContaining({
      userIds: [AGENT], event: 'campaign_finished', link: `/broadcasts/${BROADCAST}`, dedupeKey: `campaign-finished:${BROADCAST}:sent`,
    }));
  });

  it('falls back to owners and admins when the creator left', async () => {
    h.answers = [[], [{ user_id: 'admin-1' }, { user_id: 'owner-1' }]];
    await notifyCampaignFinished(row);
    expect(h.queries[1].sql).toContain("role IN ('owner','admin')");
    expect(h.create).toHaveBeenCalledWith(tx, expect.objectContaining({ userIds: ['admin-1', 'owner-1'] }));
  });

  it('never throws, so the finished campaign job is not failed by an alert', async () => {
    h.failTenant = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyCampaignFinished(row)).resolves.toEqual({ inApp: [], emailQueued: [] });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Diwali');
    errors.mockRestore();
  });
});

describe('notifyTemplateRejected', () => {
  const row = { id: TEMPLATE, account_id: ACCOUNT, name: 'order_update', status: 'REJECTED', rejection_reason: 'INVALID_FORMAT' };

  it('ignores any other status', async () => {
    await notifyTemplateRejected({ ...row, status: 'APPROVED' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('alerts owners and admins once per rejection run', async () => {
    h.answers = [[{ id: EVENT }], [{ user_id: 'admin-1' }]];
    await notifyTemplateRejected(row);
    expect(h.create).toHaveBeenCalledWith(tx, expect.objectContaining({
      userIds: ['admin-1'], event: 'template_rejected', title: 'Template "order_update" was rejected',
      body: "Meta's reason: INVALID_FORMAT", link: '/settings?tab=templates',
      dedupeKey: `template-rejected:${TEMPLATE}:${EVENT}`,
    }));
  });

  it('never throws', async () => {
    h.failTenant = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyTemplateRejected(row)).resolves.toEqual({ inApp: [], emailQueued: [] });
  });
});
