import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createPaymentLinkRecord: vi.fn() }));
vi.mock('@/lib/payments/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/links')>()),
  createPaymentLinkRecord: mocks.createPaymentLinkRecord,
}));

import { PaymentLinkError } from '@/lib/payments/links';
import { buyButtonProblem, buyButtonReference, buyButtonSlot, buyButtonUrl, type BuyButton } from './buy-button';

const run = { id: '22222222-2222-4222-8222-222222222222', account_id: '11111111-1111-4111-8111-111111111111',
  contact_id: '55555555-5555-4555-8555-555555555555', conversation_id: '66666666-6666-4666-8666-666666666666' };
const button: BuyButton = { type: 'buy', title: 'Buy now', amount_minor: 49900, currency: 'INR' };
const link = (status: string, url = 'https://rzp.io/l/abc') => ({ link: { status, short_url: url }, outcome: 'created' });

beforeEach(() => vi.clearAllMocks());

describe('buy button keys', () => {
  it('one reference per run, step and slot, within the payment-link reference format', () => {
    const ref = buyButtonReference(run.id, 'card_1', buyButtonSlot(0, 1));
    expect(ref).toMatch(/^[A-Za-z0-9_-]{16,40}$/);
    expect(buyButtonReference(run.id, 'card_1', buyButtonSlot(0, 1))).toBe(ref);
    expect(buyButtonReference(run.id, 'card_1', buyButtonSlot(0, 2))).not.toBe(ref);
    expect(buyButtonReference(run.id, 'card_2', buyButtonSlot(0, 1))).not.toBe(ref);
    expect(buyButtonReference('77777777-7777-4777-8777-777777777777', 'card_1', buyButtonSlot(0, 1))).not.toBe(ref);
  });
  it.each([
    [{ ...button, title: '' }, 'title'],
    [{ ...button, title: 'x'.repeat(21) }, 'title'],
    [{ ...button, currency: 'XXXX' }, 'currency'],
    [{ ...button, amount_minor: 0 }, 'amount'],
    [{ ...button, amount_minor: 1.5 }, 'amount'],
  ])('refuses an invalid button %#', (b, problem) => {
    expect(buyButtonProblem(b)).toBe(problem);
  });
});

describe('buyButtonUrl', () => {
  it('creates the link through the payment-link code with the run, step and a stable reference', async () => {
    mocks.createPaymentLinkRecord.mockResolvedValue(link('created'));
    expect(await buyButtonUrl(run, 'card_1', 'card:0:button:1', button)).toBe('https://rzp.io/l/abc');
    expect(mocks.createPaymentLinkRecord).toHaveBeenCalledWith(expect.objectContaining({
      accountId: run.account_id, actor: { kind: 'bot' }, amountMinor: 49900, currency: 'INR', contactId: run.contact_id,
      conversationId: run.conversation_id, flowRunId: run.id, nodeKey: 'card_1', referenceId: buyButtonReference(run.id, 'card_1', 'card:0:button:1'),
    }));
  });
  it('drops the button for a link that cannot be paid, an error, or a missing contact', async () => {
    mocks.createPaymentLinkRecord.mockResolvedValueOnce(link('unknown'));
    expect(await buyButtonUrl(run, 'card_1', 'card:0:button:1', button)).toBeNull();
    mocks.createPaymentLinkRecord.mockResolvedValueOnce(link('created', 'http://insecure.example'));
    expect(await buyButtonUrl(run, 'card_1', 'card:0:button:1', button)).toBeNull();
    mocks.createPaymentLinkRecord.mockRejectedValueOnce(new PaymentLinkError('not_connected' as never));
    expect(await buyButtonUrl(run, 'card_1', 'card:0:button:1', button)).toBeNull();
    expect(await buyButtonUrl({ ...run, contact_id: null }, 'card_1', 'card:0:button:1', button)).toBeNull();
    expect(await buyButtonUrl(run, 'card_1', 'bad slot!', button)).toBeNull();
  });
});
