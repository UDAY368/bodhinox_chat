import { describe, expect, it } from 'vitest';

import { eventFilterProblems, eventFiltersMatch, EVENT_TRIGGER_FILTERS } from './trigger-filters';
import { EVENT_TRIGGER_TYPES } from './types';
import { triggerMatches } from '@/lib/automations/engine';
import { validateTriggerForActivation } from '@/lib/automations/validate';
import { validateFlowForActivation } from '@/lib/flows/validate';
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/types';
import { automationTriggerAvailableOn, triggerAvailableOn } from '@/lib/channels/capabilities';
import type { Automation } from '@/types';

const PIPE = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';

describe('event trigger filters', () => {
  it('matches every event when no filter is set', () => {
    for (const trigger of EVENT_TRIGGER_TYPES) expect(eventFiltersMatch(trigger, {}, { service_id: 'x' })).toBe(true);
  });

  it('matches a deal move on the chosen pipeline and stage only', () => {
    const data = { deal_id: 'd', pipeline_id: PIPE, to_stage_id: STAGE };
    expect(eventFiltersMatch('deal_stage_changed', { pipeline_id: PIPE }, data)).toBe(true);
    expect(eventFiltersMatch('deal_stage_changed', { pipeline_id: PIPE, to_stage_id: STAGE }, data)).toBe(true);
    expect(eventFiltersMatch('deal_stage_changed', { pipeline_id: PIPE, to_stage_id: FORM }, data)).toBe(false);
    expect(eventFiltersMatch('deal_stage_changed', { pipeline_id: FORM }, data)).toBe(false);
  });

  it('matches a form answer and an order source', () => {
    expect(eventFiltersMatch('form_submitted', { form_id: FORM }, { form_id: FORM })).toBe(true);
    expect(eventFiltersMatch('form_submitted', { form_id: FORM }, { form_id: PIPE })).toBe(false);
    expect(eventFiltersMatch('order_paid', { source: 'shopify' }, { source: 'shopify' })).toBe(true);
    expect(eventFiltersMatch('order_paid', { source: 'shopify' }, { source: 'manual' })).toBe(false);
    // A filter on a field the event does not carry never matches.
    expect(eventFiltersMatch('order_paid', { source: 'shopify' }, {})).toBe(false);
  });

  it('keeps the appointment service list', () => {
    expect(eventFiltersMatch('appointment_booked', { service_ids: [PIPE] }, { service_id: PIPE })).toBe(true);
    expect(eventFiltersMatch('appointment_booked', { service_ids: [PIPE] }, { service_id: STAGE })).toBe(false);
  });

  it('reports malformed filters', () => {
    expect(eventFilterProblems('deal_stage_changed', { pipeline_id: 'nope' })).toEqual(['pipeline_id']);
    expect(eventFilterProblems('deal_stage_changed', { to_stage_id: STAGE })).toEqual(['pipeline_id']);
    expect(eventFilterProblems('order_created', { source: 'ebay' })).toEqual(['source']);
    expect(eventFilterProblems('form_submitted', { form_id: FORM })).toEqual([]);
    expect(eventFilterProblems('payment_received', { anything: 'x' })).toEqual([]);
  });

  it('has a filter list for every event trigger', () => {
    expect(Object.keys(EVENT_TRIGGER_FILTERS).sort()).toEqual([...EVENT_TRIGGER_TYPES].sort());
  });
});

describe('event triggers in rules and flows', () => {
  const rule = (trigger_type: string, trigger_config: Record<string, unknown>): Automation => ({
    id: 'a', account_id: 'acc', user_id: 'u', name: 'r', trigger_type: trigger_type as Automation['trigger_type'],
    trigger_config, is_active: true, execution_count: 0, created_at: '', updated_at: '',
  });

  it('a rule fires only with an event whose data passes its filters', () => {
    const r = rule('deal_stage_changed', { pipeline_id: PIPE, to_stage_id: STAGE });
    expect(triggerMatches(r, undefined)).toBe(false);
    expect(triggerMatches(r, { event: { type: 'deal.stage_changed', data: { pipeline_id: PIPE, to_stage_id: STAGE } } })).toBe(true);
    expect(triggerMatches(r, { event: { type: 'deal.stage_changed', data: { pipeline_id: PIPE, to_stage_id: FORM } } })).toBe(false);
    expect(triggerMatches(rule('cart_abandoned', {}), { event: { type: 'cart.abandoned', data: {} } })).toBe(true);
  });

  it('every event trigger is a WhatsApp rule and flow trigger, never an Instagram one', () => {
    for (const trigger of EVENT_TRIGGER_TYPES) {
      expect(FLOW_TRIGGER_TYPES).toContain(trigger);
      expect(triggerAvailableOn(trigger, 'whatsapp')).toBe(true);
      expect(triggerAvailableOn(trigger, 'instagram')).toBe(false);
      expect(automationTriggerAvailableOn(trigger, 'whatsapp')).toBe(true);
      expect(automationTriggerAvailableOn(trigger, 'instagram')).toBe(false);
    }
  });

  it('the rule validator refuses a malformed filter and an Instagram event rule', () => {
    expect(validateTriggerForActivation('order_paid', { source: 'shopify' })).toEqual([]);
    expect(validateTriggerForActivation('order_paid', { source: 'ebay' }).map((i) => i.path)).toEqual(['trigger.source']);
    expect(validateTriggerForActivation('order_paid', {}, [], 'instagram').map((i) => i.path)).toEqual(['trigger.type']);
  });

  it('the flow validator refuses a malformed filter', () => {
    const nodes = [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'hi' } },
      { node_key: 'hi', node_type: 'send_message', config: { text: 'Paid, thanks', next_node_key: '' } },
    ];
    const errors = (config: Record<string, unknown>) => validateFlowForActivation(
      { name: 'Paid', trigger_type: 'order_paid', trigger_config: config, entry_node_id: 'start', channel_scope: 'whatsapp' } as Parameters<typeof validateFlowForActivation>[0],
      nodes).filter((i) => i.scope === 'trigger' && i.severity === 'error');
    expect(errors({})).toEqual([]);
    expect(errors({ source: 'ebay' }).map((i) => i.field)).toEqual(['trigger_config.source']);
  });
});
