import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from './order-format';
import {
  allowedActions, amountDue, amountRefundable, canCancelAndRefund, canCancelUnpaid, canChangeStatusByHand, canDeliver, canRecordPayment,
  canShip, canStartReturn, canTakeLinkPayment, canTransition, fulfilmentState, FULFILMENT_TONE, isReadyToShip, nextStep, nextStepAction,
  ORDER_TRANSITIONS, PAYMENT_TONE, paymentState, refundedBeforeShipping, selectableStatuses, STATUS_TONE, WORKER_ONLY_STATUSES,
  type NextStep, type OrderAction, type OrderFacts,
} from './order-state';

const PRICED = '2026-11-13T10:00:00Z';
const PAID_AT = '2026-11-14T10:00:00Z';
const money = { total_minor: 10_000, subtotal_minor: 10_000, amount_paid_minor: 0 };
const online = (status: OrderStatus, extra: Partial<OrderFacts> = {}): OrderFacts =>
  ({ status, priced_at: PRICED, payment_method: 'online', paid_at: null, refund_state: 'none', ...money, ...extra });
const paidOnline = (status: OrderStatus, extra: Partial<OrderFacts> = {}): OrderFacts =>
  online(status, { paid_at: PAID_AT, amount_paid_minor: 10_000, ...extra });
const cod = (status: OrderStatus, extra: Partial<OrderFacts> = {}): OrderFacts => online(status, { payment_method: 'cod', ...extra });
const legacy = (status: OrderStatus): OrderFacts => ({ status, priced_at: null, subtotal_minor: 5_000, total_minor: null, amount_paid_minor: 0 });

const AGENT = { canAct: true, canAdmin: false };
const ADMIN = { canAct: true, canAdmin: true };
const VIEWER = { canAct: false, canAdmin: false };

describe('transitions', () => {
  it('never moves to the same status, back to new, or to a worker-only status', () => {
    for (const from of ORDER_STATUSES) {
      expect(canTransition(from, from)).toBe(false);
      expect(canTransition(from, 'new')).toBe(false);
      for (const to of WORKER_ONLY_STATUSES) expect(canTransition(from, to, { priced: true, unpaidCod: true })).toBe(false);
    }
  });
  it('keeps the closed statuses closed', () => {
    for (const from of ['fulfilled', 'cancelled', 'expired', 'payment_review'] as const) expect(ORDER_TRANSITIONS[from]).toEqual([]);
  });
  it('cancels a paid order only with Cancel and refund', () => {
    expect(canTransition('paid', 'cancelled')).toBe(true);
    expect(canChangeStatusByHand('paid', 'cancelled')).toBe(false);
    expect(canChangeStatusByHand('awaiting_payment', 'cancelled', { priced: true })).toBe(true);
    expect(canCancelAndRefund('paid')).toBe(true);
    for (const s of ORDER_STATUSES.filter((x) => x !== 'paid')) expect(canCancelAndRefund(s)).toBe(false);
  });
});

describe('nextStep', () => {
  const table: Array<[string, OrderFacts, NextStep | null]> = [
    ['new legacy cart: confirm', legacy('new'), 'confirm'],
    ['confirmed legacy cart: deliver', legacy('confirmed'), 'deliver'],
    ['new priced order: confirm', online('new'), 'confirm'],
    ['confirmed online order not paid: collect payment', online('confirmed'), 'collect_payment'],
    ['awaiting payment: collect payment', online('awaiting_payment'), 'collect_payment'],
    ['awaiting payment with nothing due: nothing', online('awaiting_payment', { amount_paid_minor: 10_000 }), null],
    ['payment review: nothing (exceptions queue)', online('payment_review'), null],
    ['paid: ship', paidOnline('paid'), 'ship'],
    ['partially shipped: ship the rest', paidOnline('partially_shipped'), 'ship'],
    ['dispatched: deliver', paidOnline('dispatched'), 'deliver'],
    ['delivered: completed, nothing', paidOnline('fulfilled'), null],
    ['cancelled: nothing', online('cancelled'), null],
    ['expired: nothing', online('expired'), null],
    ['unpaid COD confirmed: ship before the cash', cod('confirmed'), 'ship'],
    ['unpaid COD dispatched: deliver', cod('dispatched'), 'deliver'],
    ['paid COD confirmed: nothing until a status moves', cod('confirmed', { paid_at: PAID_AT, amount_paid_minor: 10_000 }), null],
    ['paid but refunded in full: never ships', paidOnline('paid', { refund_state: 'full' }), null],
    ['dispatched and refunded in full: still deliverable', paidOnline('dispatched', { refund_state: 'full' }), 'deliver'],
  ];
  it.each(table)('%s', (_label, order, step) => {
    expect(nextStep(order)).toBe(step);
  });
});

describe('allowedActions', () => {
  const table: Array<[string, OrderFacts, typeof ADMIN, OrderAction[]]> = [
    ['viewer can do nothing', paidOnline('paid'), VIEWER, []],
    ['new priced order, agent', online('new'), AGENT, ['confirm', 'send_payment_link', 'cancel']],
    ['new priced order, admin also records payment', online('new'), ADMIN, ['confirm', 'send_payment_link', 'record_payment', 'cancel']],
    ['new legacy cart can also be moved to awaiting payment', legacy('new'), AGENT, ['confirm', 'change_status', 'cancel']],
    ['awaiting payment, admin', online('awaiting_payment'), ADMIN, ['send_payment_link', 'record_payment', 'cancel']],
    ['paid, agent ships', paidOnline('paid'), AGENT, ['ship']],
    ['paid, admin ships or cancels and refunds', paidOnline('paid'), ADMIN, ['ship', 'cancel_and_refund']],
    ['paid and refunded in full, admin: no ship', paidOnline('paid', { refund_state: 'full' }), ADMIN, ['cancel_and_refund']],
    ['dispatched online, admin', paidOnline('dispatched'), ADMIN, ['deliver']],
    ['delivered with a chat: only an update', paidOnline('fulfilled', { conversation_id: 'c1' }), ADMIN, ['send_update']],
    ['unpaid COD confirmed, admin', cod('confirmed'), ADMIN, ['record_payment', 'ship', 'deliver', 'cancel']],
    ['unpaid COD confirmed with a live courier shipment: no cash recording', cod('confirmed', { shipment: { create_state: 'created' } }), ADMIN,
      ['ship', 'deliver', 'cancel']],
    ['unpaid COD confirmed with a failed shipment: cash recording again', cod('confirmed', { shipment: { create_state: 'failed' } }), ADMIN,
      ['record_payment', 'ship', 'deliver', 'cancel']],
    ['unpaid COD returned to origin (dispatched), admin', cod('dispatched'), ADMIN, ['record_payment', 'deliver', 'cancel']],
    ['unpaid COD delivered, admin collects the cash', cod('fulfilled'), ADMIN, ['record_payment']],
    ['cancelled order: nothing', online('cancelled'), ADMIN, []],
  ];
  it.each(table)('%s', (_label, order, who, actions) => {
    expect(allowedActions(order, who)).toEqual(actions);
  });

  it('gives agents no admin-only action in any state', () => {
    for (const status of ORDER_STATUSES) for (const order of [online(status), cod(status), paidOnline(status), legacy(status)]) {
      const actions = allowedActions(order, AGENT);
      expect(actions).not.toContain('record_payment');
      expect(actions).not.toContain('cancel_and_refund');
    }
  });

  it('never offers a step the transition rules refuse', () => {
    for (const status of ORDER_STATUSES) for (const order of [online(status), cod(status), paidOnline(status), legacy(status)]) {
      const actions = allowedActions(order, ADMIN);
      const opts = { priced: !!order.priced_at, unpaidCod: order.payment_method === 'cod' && !order.paid_at && !!order.priced_at };
      if (actions.includes('ship')) expect(canTransition(status, 'dispatched', opts)).toBe(true);
      if (actions.includes('deliver')) expect(canTransition(status, 'fulfilled', opts)).toBe(true);
      if (actions.includes('cancel')) expect(canChangeStatusByHand(status, 'cancelled', opts)).toBe(true);
      for (const s of selectableStatuses(order)) expect(canChangeStatusByHand(status, s, opts)).toBe(true);
    }
  });
});

describe('nextStepAction', () => {
  it('collects payment with a link when the member can, otherwise by recording it', () => {
    expect(nextStepAction('collect_payment', ['send_payment_link', 'record_payment'])).toBe('send_payment_link');
    expect(nextStepAction('collect_payment', ['record_payment'])).toBe('record_payment');
    expect(nextStepAction('collect_payment', [])).toBeNull();
    expect(nextStepAction('ship', ['ship'])).toBe('ship');
    expect(nextStepAction('ship', [])).toBeNull();
    expect(nextStepAction(null, ['ship'])).toBeNull();
  });
});

describe('selectableStatuses', () => {
  it('leaves dispatch, delivery and cancelling to their own actions', () => {
    expect(selectableStatuses(legacy('new'))).toEqual(['confirmed', 'awaiting_payment']);
    expect(selectableStatuses(legacy('confirmed'))).toEqual(['awaiting_payment']);
    expect(selectableStatuses(online('awaiting_payment'))).toEqual([]);
    expect(selectableStatuses(paidOnline('paid'))).toEqual([]);
    expect(selectableStatuses(cod('dispatched'))).toEqual([]);
    for (const status of ORDER_STATUSES) expect(selectableStatuses(legacy(status))).not.toContain('paid');
  });
});

describe('payment rules', () => {
  it('offers a link or a plain cancel only while nothing is paid', () => {
    expect(canTakeLinkPayment(online('confirmed'))).toBe(true);
    expect(canTakeLinkPayment(cod('confirmed'))).toBe(false);
    expect(canTakeLinkPayment(paidOnline('paid'))).toBe(false);
    expect(canCancelUnpaid(online('awaiting_payment'))).toBe(true);
    expect(canCancelUnpaid(online('confirmed', { amount_paid_minor: 100 }))).toBe(false);
    expect(canCancelUnpaid(online('dispatched'))).toBe(false);
    expect(canCancelUnpaid(cod('dispatched'))).toBe(true);
    expect(canCancelUnpaid(paidOnline('paid'))).toBe(false);
  });
  it('records a payment only while money is due on a priced order', () => {
    expect(canRecordPayment(online('awaiting_payment'))).toBe(true);
    expect(canRecordPayment(legacy('new'))).toBe(false);
    expect(canRecordPayment(paidOnline('dispatched'))).toBe(false);
    expect(canRecordPayment(online('dispatched'))).toBe(false);
    expect(canRecordPayment(cod('fulfilled'))).toBe(true);
    expect(canRecordPayment(cod('fulfilled', { paid_at: PAID_AT, amount_paid_minor: 10_000 }))).toBe(false);
    expect(canRecordPayment(cod('partially_shipped', { shipment: { create_state: 'creating' } }))).toBe(false);
  });
  it('works out what is due and what can still be refunded', () => {
    expect(amountDue({ total_minor: 1_000, subtotal_minor: 900, amount_paid_minor: 400 })).toBe(600);
    expect(amountDue({ total_minor: null, subtotal_minor: 900, amount_paid_minor: 0 })).toBe(900);
    expect(amountRefundable({ amount_paid_minor: 1_000, amount_refunded_minor: 300 })).toBe(700);
    expect(amountRefundable({ amount_paid_minor: 1_000, amount_refunded_minor: 1_200 })).toBe(0);
  });
});

describe('shipping rules', () => {
  it('ships a paid order or an unpaid COD order, never one refunded in full before it left', () => {
    expect(isReadyToShip({ status: 'paid', unpaidCod: false })).toBe(true);
    expect(isReadyToShip({ status: 'partially_shipped', unpaidCod: false })).toBe(true);
    expect(isReadyToShip({ status: 'confirmed', unpaidCod: true })).toBe(true);
    expect(isReadyToShip({ status: 'confirmed', unpaidCod: false })).toBe(false);
    expect(refundedBeforeShipping({ status: 'paid', refund_state: 'full' })).toBe(true);
    expect(refundedBeforeShipping({ status: 'fulfilled', refund_state: 'full' })).toBe(false);
    expect(canShip(paidOnline('paid', { refund_state: 'full' }))).toBe(false);
    expect(canDeliver(paidOnline('paid', { refund_state: 'full' }))).toBe(false);
    expect(canShip(online('confirmed'))).toBe(false);
  });
  it('opens returns only once the goods left', () => {
    expect(ORDER_STATUSES.filter(canStartReturn)).toEqual(['dispatched', 'fulfilled']);
  });
});

describe('display states', () => {
  it('shows refunds first, then paid, cash on delivery and waiting', () => {
    expect(paymentState({ status: 'cancelled', paid_at: 'x', refund_state: 'full' })).toBe('refunded');
    expect(paymentState({ status: 'paid', paid_at: 'x', refund_state: 'partial' })).toBe('partlyRefunded');
    expect(paymentState({ status: 'dispatched', paid_at: 'x', refund_state: 'none' })).toBe('paid');
    expect(paymentState({ status: 'confirmed', paid_at: null, payment_method: 'cod' })).toBe('cod');
    expect(paymentState({ status: 'cancelled', paid_at: null, payment_method: 'cod' })).toBe('pending');
    expect(paymentState({ status: 'awaiting_payment' })).toBe('pending');
  });
  it('maps every status to a fulfilment state and every state to a tone', () => {
    expect(ORDER_STATUSES.map(fulfilmentState)).toEqual([
      'new', 'confirmed', 'new', 'review', 'new', 'partlyShipped', 'shipped', 'delivered', 'expired', 'cancelled',
    ]);
    for (const s of ORDER_STATUSES) {
      expect(STATUS_TONE[s]).toBeDefined();
      expect(FULFILMENT_TONE[fulfilmentState(s)]).toBeDefined();
    }
    expect(Object.keys(PAYMENT_TONE).sort()).toEqual(['cod', 'paid', 'partlyRefunded', 'pending', 'refunded']);
  });
});
