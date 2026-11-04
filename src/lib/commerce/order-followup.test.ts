import { describe, expect, it } from 'vitest';
import {
  agentHoldRefusal, consentRefusal, followupApplies, followupBodyValues, NOTICE_TEMPLATE_CATEGORY, ORDER_FOLLOWUP_KINDS, orderReference, orderTemplateOutcome,
  shipmentTrackingUrl,
} from './order-followup';

describe('followupApplies', () => {
  const order = (over: Partial<{ status: string; refund_state: string; feedback_score: number | null }> = {}) =>
    ({ status: 'fulfilled', refund_state: 'none', feedback_score: null, ...over });
  it('sends the dispatch notice only while dispatched, the rest only once delivered', () => {
    expect(followupApplies(order({ status: 'dispatched' }), 'dispatched')).toBeNull();
    expect(followupApplies(order(), 'dispatched')).toBe('stale_status');
    expect(followupApplies(order({ status: 'cancelled' }), 'delivered')).toBe('stale_status');
    expect(followupApplies(order(), 'delivered')).toBeNull();
    expect(followupApplies(order(), 'product_follow_up')).toBeNull();
  });
  it('skips a fully refunded order and an answered feedback request', () => {
    expect(followupApplies(order({ refund_state: 'full' }), 'feedback')).toBe('refunded');
    expect(followupApplies(order({ refund_state: 'full' }), 'product_follow_up')).toBe('refunded');
    expect(followupApplies(order({ refund_state: 'partial' }), 'feedback')).toBeNull();
    expect(followupApplies(order({ feedback_score: 3 }), 'feedback')).toBe('feedback_recorded');
  });
});

describe('consentRefusal', () => {
  const bought = new Date('2026-11-01T10:00:00Z');
  it('refuses a blocked contact and an opt-out after the purchase only', () => {
    expect(consentRefusal({ blocked_at: new Date(), opted_out_at: null }, bought)).toBe('contact_blocked');
    expect(consentRefusal({ blocked_at: null, opted_out_at: new Date('2026-11-02T00:00:00Z') }, bought)).toBe('opted_out');
    expect(consentRefusal({ blocked_at: null, opted_out_at: new Date('2026-10-01T00:00:00Z') }, bought)).toBeNull();
    expect(consentRefusal({ blocked_at: null, opted_out_at: null }, bought)).toBeNull();
  });
});

describe('orderTemplateOutcome', () => {
  const base = {
    name: 'refill', language: 'en', status: 'APPROVED', waba_id: null, category: 'UTILITY', body_text: 'Hi {{1}}, time to refill {{2}}',
    header_type: null, header_content: null, header_media_url: null, buttons: [], template_kind: null, cards: null, lto: null,
  } as never as Parameters<typeof orderTemplateOutcome>[0] & object;
  const number = { id: 'n', waba_id: null };
  it('allows an approved UTILITY template', () => {
    expect(orderTemplateOutcome(base, number)).toBeNull();
  });
  it('blocks a missing, unapproved, marketing or variable-URL template', () => {
    expect(orderTemplateOutcome(null, number)).toEqual({ status: 'blocked', reason: 'template_not_found' });
    expect(orderTemplateOutcome({ ...base, status: 'PENDING' }, number)).toEqual({ status: 'blocked', reason: 'template_not_approved' });
    expect(orderTemplateOutcome({ ...base, category: 'MARKETING' } as never, number)).toEqual({ status: 'blocked', reason: 'category' });
    expect(orderTemplateOutcome({ ...base, buttons: [{ type: 'URL', text: 'Shop', url: 'https://shop.example/{{1}}' }] } as never, number))
      .toEqual({ status: 'blocked', reason: 'template_refused' });
  });
});

describe('followupBodyValues', () => {
  it('fills only the variables the template uses, never empty', () => {
    expect(followupBodyValues({ body_text: 'Hi {{1}}, refill {{2}}' } as never, ['Asha', 'Tulsi', '#A1'])).toEqual(['Asha', 'Tulsi']);
    expect(followupBodyValues({ body_text: 'No vars' } as never, ['Asha'])).toEqual([]);
    expect(followupBodyValues({ body_text: '{{3}}' } as never, ['', ''])).toEqual(['-', '-', '-']);
  });
  it('names the order by its store number or short id', () => {
    expect(orderReference({ id: 'abcdef12-0000-4000-8000-000000000000', external_id: null })).toBe('ABCDEF12');
    expect(orderReference({ id: 'x', external_id: '1001' })).toBe('#1001');
  });
});

describe('repeat purchase (Phase 9 D13)', () => {
  const base = {
    name: 'reorder', language: 'en', status: 'APPROVED', waba_id: null, category: 'MARKETING', body_text: 'Hi {{1}}, more {{2}}?',
    header_type: null, header_content: null, header_media_url: null, buttons: [], template_kind: null, cards: null, lto: null,
  } as never as Parameters<typeof orderTemplateOutcome>[0] & object;
  const number = { id: 'n', waba_id: null };
  it('needs a MARKETING template for the reminder and a UTILITY one for the notices', () => {
    expect(orderTemplateOutcome(base, number, 'MARKETING')).toBeNull();
    expect(orderTemplateOutcome({ ...base, category: 'UTILITY' } as never, number, 'MARKETING')).toEqual({ status: 'blocked', reason: 'category' });
    expect(orderTemplateOutcome(base, number, 'UTILITY')).toEqual({ status: 'blocked', reason: 'category' });
    expect(orderTemplateOutcome({ ...base, template_kind: 'carousel' } as never, number, 'MARKETING'))
      .toEqual({ status: 'blocked', reason: 'template_refused' });
  });
  it('applies only to a delivered order that was not fully refunded', () => {
    const order = { status: 'fulfilled', refund_state: 'none', feedback_score: 5 };
    expect(followupApplies(order, 'repeat_purchase')).toBeNull();
    expect(followupApplies({ ...order, status: 'dispatched' }, 'repeat_purchase')).toBe('stale_status');
    expect(followupApplies({ ...order, refund_state: 'full' }, 'repeat_purchase')).toBe('refunded');
  });
  it('names a courier tracking page only for a well-formed AWB', () => {
    expect(shipmentTrackingUrl('AWB-1234')).toBe('https://shiprocket.co/tracking/AWB-1234');
    expect(shipmentTrackingUrl('../x?y')).toBeNull();
    expect(shipmentTrackingUrl(null)).toBeNull();
  });
  it('maps each notice kind to its template category', () => {
    expect(NOTICE_TEMPLATE_CATEGORY).toEqual({ dispatched: 'UTILITY', delivered: 'UTILITY', feedback: 'UTILITY', repeat_purchase: 'MARKETING' });
    expect(ORDER_FOLLOWUP_KINDS).toContain('repeat_purchase');
  });
});

describe('agentHoldRefusal', () => {
  it('holds back only the marketing reminder while an agent has taken over the chat', () => {
    expect(agentHoldRefusal('repeat_purchase', true)).toBe('bot_paused');
    expect(agentHoldRefusal('repeat_purchase', false)).toBeNull();
    for (const kind of ORDER_FOLLOWUP_KINDS.filter((k) => k !== 'repeat_purchase')) expect(agentHoldRefusal(kind, true)).toBeNull();
  });
});
