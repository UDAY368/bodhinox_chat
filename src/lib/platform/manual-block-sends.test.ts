// Phase 14 review (lifecycle F2): block_manual refuses every agent-originated
// send core, not only the inbox composer. The tenant transaction is faked; the
// check runs before any conversation read, intent claim or Meta call.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ blocked: true, dispatched: 0, queries: [] as string[] }));

vi.mock('@/lib/db/prisma', () => ({ getPrisma: () => ({}), getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async (sql: TemplateStringsArray) => { h.queries.push(sql.join('?')); return []; },
    $queryRawUnsafe: async (sql: string) => { h.queries.push(sql); return []; },
    $executeRaw: async () => 0,
  }),
}));
vi.mock('./lifecycle', () => ({ manualRepliesBlockedIn: async () => h.blocked }));
vi.mock('@/lib/jobs/dispatch', async (original) => ({
  ...(await original<typeof import('@/lib/jobs/dispatch')>()),
  dispatchOnce: async () => { h.dispatched++; return { whatsapp_message_id: 'wamid', messageId: 'wamid' }; },
}));

import { CommerceSendError, sendCommerceMessage } from '@/lib/commerce/catalog-send';
import { PaymentLinkError, sendPaymentLinkMessage } from '@/lib/payments/links';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';

beforeEach(() => { h.blocked = true; h.dispatched = 0; h.queries = []; });

describe('manual-reply block in the shared send cores', () => {
  it('refuses an agent product message with 403 workspace_manual_blocked and no Meta call', async () => {
    const error = await sendCommerceMessage({
      accountId: ACCOUNT, userId: USER, role: 'agent', conversationId: CONVERSATION, sender: 'agent',
      message: { kind: 'product', product: { id: PRODUCT } }, intentKey: 'k1',
    } as Parameters<typeof sendCommerceMessage>[0]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommerceSendError);
    expect(error).toMatchObject({ code: 'workspace_manual_blocked', status: 403 });
    expect(h.dispatched).toBe(0);
    expect(h.queries).toEqual([]);
  });

  it('does not apply the manual block to a bot (flow) product message', async () => {
    const error = await sendCommerceMessage({
      accountId: ACCOUNT, userId: USER, role: 'owner', conversationId: CONVERSATION, sender: 'bot',
      message: { kind: 'product', product: { id: PRODUCT } }, intentKey: 'k2',
    } as Parameters<typeof sendCommerceMessage>[0]).catch((e: unknown) => e);
    // It goes on to read the conversation (none here) instead of refusing on the block.
    expect(error).toMatchObject({ code: 'conversation_not_found' });
  });

  it('refuses a member-sent payment link but not an automatic one', async () => {
    const manual = await sendPaymentLinkMessage({ accountId: ACCOUNT, userId: USER, role: 'agent', linkId: PRODUCT, intentKey: 'k3', manual: true })
      .catch((e: unknown) => e);
    expect(manual).toBeInstanceOf(PaymentLinkError);
    expect(manual).toMatchObject({ code: 'workspace_manual_blocked', status: 403 });
    expect(h.dispatched).toBe(0);
    const automatic = await sendPaymentLinkMessage({ accountId: ACCOUNT, userId: USER, role: 'owner', linkId: PRODUCT, intentKey: 'k4' })
      .catch((e: unknown) => e);
    expect(automatic).toMatchObject({ code: 'not_found' });
  });
});
