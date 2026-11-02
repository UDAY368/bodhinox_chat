import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  changeTiming,
  GRACE_DAYS,
  needsReconcile,
  sweepTransition,
  switchesPlanLimits,
  type ProviderSnapshot,
  type SubscriptionRow,
} from './lifecycle';

const DAY = 86_400_000;
const now = new Date('2026-11-02T10:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);

const snap = (over: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
  subscriptionId: 'sub_A', customerId: 'cust_A', status: 'active', planId: 'pro', interval: 'month',
  currentStart: now, currentEnd: at(30), startAt: null, ...over,
});

/** Runs a sequence of provider states through the machine. */
function run(steps: (Partial<ProviderSnapshot> & { when?: Date })[], start: SubscriptionRow | null = null) {
  let row = start;
  const notices: string[] = [];
  for (const { when, ...s } of steps) {
    const t = applySnapshot(row, snap(s), when ?? now);
    if (t) { row = t.next; notices.push(...t.notices); }
  }
  return { row: row!, notices };
}

describe('applySnapshot', () => {
  it('keeps a checkout out of account_subscriptions until it is authorised', () => {
    expect(applySnapshot(null, snap({ status: 'incomplete' }), now)).toBeNull();
    expect(applySnapshot(null, snap({ status: 'cancelled' }), now)).toBeNull();
    expect(applySnapshot(null, snap({ status: null }), now)).toBeNull();
    // An unmapped provider plan never guesses a plan.
    expect(applySnapshot(null, snap({ planId: null }), now)).toBeNull();
  });

  it('moves a trial to active on the first charge', () => {
    const { row, notices } = run([
      { status: 'trialing', startAt: at(14), currentStart: null, currentEnd: null },
      { status: 'active', currentStart: at(14), currentEnd: at(44), when: at(14) },
    ]);
    expect(row).toMatchObject({ status: 'active', planId: 'pro', trialEndsAt: at(14), currentPeriodEnd: at(44), providerSubscriptionId: 'sub_A' });
    expect(notices).toEqual(['activated']);
  });

  it('goes past_due -> grace (7 days) -> suspended by the sweep, and recovers on payment', () => {
    const active = run([{ status: 'active' }]).row;
    const failed = applySnapshot(active, snap({ status: 'past_due' }), at(30))!;
    expect(failed.next.status).toBe('past_due');
    expect(failed.notices).toEqual(['payment_failed']);

    const halted = applySnapshot(failed.next, snap({ status: 'grace' }), at(33))!;
    expect(halted.next).toMatchObject({ status: 'grace', graceEndsAt: at(33 + GRACE_DAYS) });
    expect(halted.notices).toEqual(['grace_started']);
    // A repeated halted event keeps the original deadline.
    expect(applySnapshot(halted.next, snap({ status: 'grace' }), at(35))!.next.graceEndsAt).toEqual(at(33 + GRACE_DAYS));

    expect(sweepTransition(halted.next, at(34))).toBeNull();
    expect(sweepTransition(halted.next, at(38))!.notices).toEqual(['grace_ending']);
    const suspended = sweepTransition(halted.next, at(40))!;
    expect(suspended.next).toMatchObject({ status: 'suspended', suspendedAt: at(40) });
    expect(suspended.notices).toEqual(['suspended']);
    // The provider still reports halted: the suspension stands.
    const still = applySnapshot(suspended.next, snap({ status: 'grace' }), at(41))!;
    expect(still.next.status).toBe('suspended');
    expect(still.notices).toEqual([]);

    const recovered = applySnapshot(suspended.next, snap({ status: 'active', currentEnd: at(72) }), at(42))!;
    expect(recovered.next).toMatchObject({ status: 'active', graceEndsAt: null, suspendedAt: null, planId: 'pro' });
    expect(recovered.notices).toEqual(['recovered']);
  });

  it('ends a subscription cancelled at period end only when the provider reports it', () => {
    const active = { ...run([{ status: 'active' }]).row, cancelAtPeriodEnd: true };
    expect(applySnapshot(active, snap({ status: 'active' }), at(10))!.next.cancelAtPeriodEnd).toBe(true);
    const ended = applySnapshot(active, snap({ status: 'cancelled' }), at(30))!;
    expect(ended.next).toMatchObject({ status: 'cancelled', cancelAtPeriodEnd: false, scheduledPlan: null });
    expect(ended.notices).toEqual(['cancelled']);
  });

  it('applies a scheduled downgrade at renewal, when the provider reports the new plan', () => {
    const active = { ...run([{ status: 'active' }]).row, scheduledPlan: 'basic' };
    // Mid-term: still pro, still scheduled.
    expect(applySnapshot(active, snap({ status: 'active' }), at(10))!.next).toMatchObject({ planId: 'pro', scheduledPlan: 'basic' });
    const renewed = applySnapshot(active, snap({ status: 'active', planId: 'basic', currentStart: at(30), currentEnd: at(60) }), at(30))!;
    expect(renewed.next).toMatchObject({ planId: 'basic', scheduledPlan: null, currentPeriodEnd: at(60) });
  });

  it('applies an upgrade immediately from the provider-confirmed plan', () => {
    const active = run([{ status: 'active', planId: 'basic' }]).row;
    expect(applySnapshot(active, snap({ status: 'active', planId: 'pro' }), at(5))!.next.planId).toBe('pro');
  });

  it('ignores a different subscription unless it grants a plan', () => {
    const active = run([{ status: 'active' }]).row;
    expect(applySnapshot(active, snap({ subscriptionId: 'sub_B', status: 'incomplete' }), now)).toBeNull();
    const replaced = applySnapshot({ ...active, status: 'cancelled' }, snap({ subscriptionId: 'sub_B', status: 'active', planId: 'basic' }), now)!;
    expect(replaced.next).toMatchObject({ providerSubscriptionId: 'sub_B', planId: 'basic', status: 'active' });
    expect(replaced.notices).toEqual(['activated']);
  });
});

describe('sweep and reconcile', () => {
  it('treats a trial that never charged as a failed payment', () => {
    const trial = run([{ status: 'trialing', startAt: at(14) }]).row;
    expect(sweepTransition(trial, at(15))).toBeNull();
    const t = sweepTransition(trial, at(18))!;
    expect(t.next).toMatchObject({ status: 'grace', graceEndsAt: at(18 + GRACE_DAYS) });
  });

  it('lets a trial that never charged run out its grace instead of recovering on every sweep', () => {
    // Trial ended at(14); the provider keeps reporting it as authenticated (trialing).
    let row = run([{ status: 'trialing', startAt: at(14) }]).row;
    const notices: string[] = [];
    let graceEnd: Date | null = null;
    for (let day = 18; day <= 30; day += 1) {
      const when = at(day);
      // The sweep fetches the provider first (needsReconcile is true in grace), then applies its own step.
      const fetched = applySnapshot(row, snap({ status: 'trialing', startAt: at(14) }), when);
      if (fetched) { row = fetched.next; notices.push(...fetched.notices); }
      const swept = sweepTransition(row, when);
      if (swept) { row = swept.next; notices.push(...swept.notices); }
      if (row.status === 'grace') graceEnd ??= row.graceEndsAt;
    }
    expect(graceEnd).toEqual(at(18 + GRACE_DAYS));
    expect(row).toMatchObject({ status: 'suspended', suspendedAt: at(18 + GRACE_DAYS) });
    expect(notices.filter((n) => n === 'grace_started')).toHaveLength(1);
    expect(notices).not.toContain('recovered');
    expect(notices.filter((n) => n === 'suspended')).toHaveLength(1);
  });

  it('still recovers from grace on a real charge or a first charge moved into the future', () => {
    const trial = run([{ status: 'trialing', startAt: at(14) }]).row;
    const grace = sweepTransition(trial, at(18))!.next;
    expect(applySnapshot(grace, snap({ status: 'active' }), at(19))).toMatchObject({ next: { status: 'active', graceEndsAt: null }, notices: ['recovered'] });
    expect(applySnapshot(grace, snap({ status: 'trialing', startAt: at(25) }), at(19))?.next.status).toBe('trialing');
    const suspended = { ...grace, status: 'suspended' as const, suspendedAt: at(25), graceEndsAt: null };
    expect(applySnapshot(suspended, snap({ status: 'trialing', startAt: at(14) }), at(26))).toBeNull();
  });

  it('fetches the provider when a reported transition is overdue', () => {
    const active = run([{ status: 'active' }]).row;
    expect(needsReconcile(active, at(10))).toBe(false);
    expect(needsReconcile(active, at(32))).toBe(true);
    expect(needsReconcile({ ...active, scheduledPlan: 'basic' }, at(30))).toBe(true);
    expect(needsReconcile({ ...active, status: 'past_due' }, at(1))).toBe(true);
    expect(needsReconcile({ ...active, providerSubscriptionId: null, status: 'past_due' }, at(1))).toBe(false);
  });
});

describe('changeTiming', () => {
  const r = (plan: string, sort: number, interval: 'month' | 'year' = 'month') => ({ plan, sort, interval });
  it('upgrades now and downgrades at period end', () => {
    expect(changeTiming(r('basic', 1), r('pro', 2))).toBe('now');
    expect(changeTiming(r('pro', 2), r('basic', 1))).toBe('period_end');
    expect(changeTiming(r('pro', 2), r('pro', 2, 'year'))).toBe('now');
    expect(changeTiming(r('pro', 2, 'year'), r('pro', 2))).toBe('period_end');
    expect(changeTiming(r('pro', 2), r('pro', 2))).toBeNull();
  });
});

describe('switchesPlanLimits', () => {
  const row = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    ...run([{ status: 'active', planId: 'pro' }]).row, ...over,
  });
  it('applies limits when a scheduled downgrade, a cancellation, an upgrade or a recovery switches the plan', () => {
    expect(switchesPlanLimits(row({ planId: 'pro', scheduledPlan: 'basic' }), row({ planId: 'basic' }))).toBe(true);
    expect(switchesPlanLimits(row(), row({ status: 'cancelled' }))).toBe(true);
    expect(switchesPlanLimits(row({ planId: 'basic' }), row({ planId: 'pro' }))).toBe(true);
    expect(switchesPlanLimits(row({ status: 'suspended' }), row({ status: 'active' }))).toBe(true);
    expect(switchesPlanLimits(row({ status: 'cancelled' }), row({ status: 'trialing', planId: 'basic' }))).toBe(true);
  });
  it('leaves everything as it is for renewals on the same plan, payment trouble, suspension and a first subscription', () => {
    expect(switchesPlanLimits(row(), row({ currentPeriodEnd: at(60) }))).toBe(false);
    expect(switchesPlanLimits(row(), row({ status: 'past_due' }))).toBe(false);
    expect(switchesPlanLimits(row({ status: 'grace' }), row({ status: 'suspended' }))).toBe(false);
    expect(switchesPlanLimits(row({ status: 'suspended' }), row({ status: 'cancelled' }))).toBe(true);
    expect(switchesPlanLimits(null, row({ planId: 'basic' }))).toBe(false);
  });
});
