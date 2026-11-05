import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderSnapshot, SubscriptionRow } from './lifecycle';
import { istDay, resetBillingReconcileScheduleForTests, runBillingReconcile, scheduleBillingReconcile, stateDifference } from './reconciliation';

const T = new Date('2093-03-10T10:00:00Z');
const row = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  planId: 'pro', status: 'active', interval: 'month', provider: 'razorpay', providerCustomerId: 'cust_1', providerSubscriptionId: 'sub_1',
  trialEndsAt: null, currentPeriodStart: new Date('2093-03-01T00:00:00Z'), currentPeriodEnd: new Date('2093-04-01T00:00:00Z'),
  cancelAtPeriodEnd: false, scheduledPlan: null, graceEndsAt: null, suspendedAt: null, ...over,
});
const snap = (over: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
  subscriptionId: 'sub_1', customerId: 'cust_1', status: 'active', planId: 'pro', interval: 'month',
  currentStart: new Date('2093-03-01T00:00:00Z'), currentEnd: new Date('2093-04-01T00:00:00Z'), startAt: null, ...over,
});

describe('stateDifference', () => {
  it('is null when the provider agrees, including a period end within the clock tolerance', () => {
    expect(stateDifference(row(), snap(), T)).toBeNull();
    expect(stateDifference(row(), snap({ currentEnd: new Date('2093-04-01T00:00:30Z') }), T)).toBeNull();
  });

  it('reports plan, status, interval and period-end differences with ids and statuses only', () => {
    const d = stateDifference(row(), snap({ planId: 'basic', status: 'past_due', interval: 'year', currentEnd: new Date('2093-05-01T00:00:00Z') }), T);
    expect(d).toMatchObject({ reason: 'differs', fields: ['plan', 'status', 'interval', 'period_end'], subscription_id: 'sub_1',
      stored: { plan: 'pro', status: 'active' }, provider: { plan: 'basic', status: 'past_due' } });
    expect(Object.keys(d!).sort()).toEqual(['fields', 'provider', 'reason', 'stored', 'subscription_id']);
  });

  it('does not report our own grace -> suspended step as a difference', () => {
    const suspended = row({ status: 'suspended', suspendedAt: new Date('2093-03-09T00:00:00Z') });
    expect(stateDifference(suspended, snap({ status: 'grace' }), T)).toBeNull();
  });

  it('reports an unmapped provider plan and an unknown provider state', () => {
    expect(stateDifference(row(), snap({ planId: null }), T)).toMatchObject({ reason: 'unmapped_plan' });
    expect(stateDifference(row(), snap({ status: null }), T)).toMatchObject({ reason: 'unknown_state' });
  });
});

describe('without the BILLING_RAZORPAY_* keys', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetBillingReconcileScheduleForTests(); });

  it('schedules nothing and the job does nothing (no provider, no database)', async () => {
    for (const k of ['BILLING_RAZORPAY_KEY_ID', 'BILLING_RAZORPAY_KEY_SECRET', 'BILLING_RAZORPAY_WEBHOOK_SECRET']) delete process.env[k];
    expect(await scheduleBillingReconcile(Date.now())).toBe(0);
    // The default provider is null without keys: the job returns before any read.
    await expect(runBillingReconcile('11111111-1111-4111-8111-111111111111')).resolves.toBeUndefined();
  });
});

it('istDay uses the Indian calendar day', () => {
  expect(istDay(new Date('2093-03-10T18:29:00Z'))).toBe('2093-03-10');
  expect(istDay(new Date('2093-03-10T18:31:00Z'))).toBe('2093-03-11');
});
