import { describe, expect, it } from 'vitest';
import { buildOrderTimeline } from './order-tracking-timeline';

const createdAt = new Date('2026-11-01T10:00:00Z');
const states = (steps: ReturnType<typeof buildOrderTimeline>) => steps.map((s) => `${s.key}:${s.state}`).join(' ');

describe('buildOrderTimeline', () => {
  it('shows a new order as placed, the rest upcoming', () => {
    expect(states(buildOrderTimeline({ status: 'new', createdAt }))).toBe(
      'placed:current confirmed:upcoming shipped:upcoming out_for_delivery:upcoming delivered:upcoming');
  });
  it('treats an order awaiting payment as not yet confirmed', () => {
    expect(buildOrderTimeline({ status: 'awaiting_payment', createdAt })[1].state).toBe('upcoming');
  });
  it('confirms a paid or confirmed order', () => {
    expect(states(buildOrderTimeline({ status: 'paid', createdAt }))).toContain('confirmed:current');
    expect(states(buildOrderTimeline({ status: 'confirmed', createdAt }))).toContain('confirmed:current');
  });
  it('marks a dispatched order shipped with its time', () => {
    const steps = buildOrderTimeline({ status: 'dispatched', createdAt, dispatchedAt: new Date('2026-11-02T08:00:00Z') });
    expect(states(steps)).toBe('placed:done confirmed:done shipped:current out_for_delivery:upcoming delivered:upcoming');
    expect(steps[2].at).toBe('2026-11-02T08:00:00.000Z');
  });
  it('lets the courier move a dispatched order to out for delivery', () => {
    const steps = buildOrderTimeline({ status: 'dispatched', createdAt, shipmentStatus: 'out_for_delivery', outForDeliveryAt: new Date('2026-11-04T06:00:00Z') });
    expect(states(steps)).toContain('out_for_delivery:current');
    expect(steps[3].at).toBe('2026-11-04T06:00:00.000Z');
  });
  it('uses courier evidence even when staff have not marked the order shipped', () => {
    expect(states(buildOrderTimeline({ status: 'confirmed', createdAt, shipmentStatus: 'in_transit' }))).toContain('shipped:current');
  });
  it('does not claim shipped for a label or pickup that has not happened', () => {
    expect(states(buildOrderTimeline({ status: 'confirmed', createdAt, shipmentStatus: 'awb_assigned' }))).toContain('confirmed:current');
  });
  it('finishes a delivered order with every step done', () => {
    const steps = buildOrderTimeline({ status: 'fulfilled', createdAt, deliveredAt: new Date('2026-11-05T12:00:00Z') });
    expect(steps.every((s) => s.state === 'done')).toBe(true);
    expect(steps[4].at).toBe('2026-11-05T12:00:00.000Z');
  });
  it('ignores a return to origin: the order status decides', () => {
    expect(states(buildOrderTimeline({ status: 'dispatched', createdAt, shipmentStatus: 'rto_initiated' }))).toContain('shipped:current');
  });
  it('shows placed then cancelled for a cancelled or expired order', () => {
    expect(states(buildOrderTimeline({ status: 'cancelled', createdAt }))).toBe('placed:done cancelled:current');
    expect(states(buildOrderTimeline({ status: 'expired', createdAt }))).toBe('placed:done cancelled:current');
  });
});
