import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.fn();
const issued = vi.fn();
const storeOpen = vi.fn();
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (strings.join('').includes('FROM contacts') ? [{ blocked_at: null }] : [{ whatsapp_config_id: null }])),
  }),
}));
vi.mock('@/lib/commerce/storefront', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/commerce/storefront')>();
  return {
    ...real,
    assertStoreOpenTx: (...args: unknown[]) => storeOpen(...args),
    latestOrderId: vi.fn(async () => null),
    issueSessionTx: (...args: unknown[]) => issued(...args),
    sendStorefrontText: (...args: unknown[]) => sent(...args),
  };
});

const { fillVars, runStorefrontLinkNode } = await import('./storefront-node');
const { StoreError } = await import('@/lib/commerce/store-settings');
const { UncertainDispatchError } = await import('@/lib/jobs/dispatch');

const base = {
  accountId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222', nodeKey: 'n1', transitionSeq: 3,
  contactId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444',
  vars: { name: 'Asha {{vars.secret}}', secret: 'x' }, config: { message: 'Hi {{vars.name}}', purpose: 'shop' as const, next_node_key: 'n2' },
};

describe('send_storefront_link runtime', () => {
  beforeEach(() => {
    sent.mockReset().mockResolvedValue({ whatsappMessageId: 'wamid.1', conversationId: base.conversationId });
    issued.mockReset().mockResolvedValue({ sessionId: 'sess', url: 'https://app.example.test/shop/tok', created: true });
    storeOpen.mockReset().mockResolvedValue(undefined);
  });

  it('fills {{vars.x}} once (customer input never expands further)', () => {
    expect(fillVars('Hi {{vars.name}} {{vars.none}}!', base.vars)).toBe('Hi Asha {{vars.secret}} !');
  });

  it('issues a replay-safe session and sends the link once per step', async () => {
    await expect(runStorefrontLinkNode(base)).resolves.toEqual({ ok: true, sessionId: 'sess', whatsappMessageId: 'wamid.1' });
    const [, , issue] = issued.mock.calls[0] as [unknown, string, { sessionId: string; ttlHours: number; purpose: string }];
    expect(issue).toMatchObject({ ttlHours: 24, purpose: 'shop' });
    await runStorefrontLinkNode(base);
    expect((issued.mock.calls[1] as [unknown, string, { sessionId: string }])[2].sessionId).toBe(issue.sessionId);
    expect(sent.mock.calls[0][0]).toMatchObject({ intentKey: `flow:${base.runId}:n1:3:storefront_link`, sender: { kind: 'bot' },
      text: 'Hi Asha {{vars.secret}}\nhttps://app.example.test/shop/tok' });
  });

  it('refuses before sending: no contact, store off, no order, outside the window', async () => {
    await expect(runStorefrontLinkNode({ ...base, contactId: null })).resolves.toEqual({ ok: false, reason: 'no_contact' });
    storeOpen.mockRejectedValueOnce(new StoreError('checkout_disabled'));
    await expect(runStorefrontLinkNode(base)).resolves.toEqual({ ok: false, reason: 'storefront_disabled' });
    await expect(runStorefrontLinkNode({ ...base, config: { ...base.config, purpose: 'status' } })).resolves.toEqual({ ok: false, reason: 'no_order' });
    sent.mockRejectedValueOnce(new StoreError('outside_window'));
    await expect(runStorefrontLinkNode(base)).resolves.toEqual({ ok: false, reason: 'outside_window' });
    await expect(runStorefrontLinkNode({ ...base, config: { ...base.config, ttl_hours: 500 } })).resolves.toEqual({ ok: false, reason: 'invalid_config' });
  });

  it('reports an ambiguous send as uncertain so the flow never offers a second link', async () => {
    sent.mockRejectedValueOnce(new UncertainDispatchError());
    await expect(runStorefrontLinkNode(base)).resolves.toEqual({ ok: false, reason: 'send_uncertain', uncertain: true });
  });
});
