import { describe, expect, it } from 'vitest';
import { availableActions, primaryAction } from './broadcast-actions';
import { bodySamples } from './broadcast-message-card';
import { broadcastStarted, broadcastWhen, sentPercent } from './broadcast-display';
import { prefillFromBroadcast } from './wizard-prefill';
import type { Broadcast } from '@/types';

const row = (status: Broadcast['status'], extra: Partial<Broadcast> = {}) =>
  ({ id: 'b', name: 'Promo', status, failed_count: 0, total_recipients: 10, kind: 'standard', ...extra }) as Broadcast;

describe('campaign actions by status', () => {
  it('offers the prototype menu, by status, with Delete last', () => {
    expect(availableActions(row('draft'), { canSend: true })).toEqual(['open', 'edit', 'duplicate', 'delete']);
    expect(availableActions(row('scheduled'), { canSend: true })).toEqual(['open', 'reschedule', 'sendNow', 'cancelSchedule', 'duplicate', 'delete']);
    expect(availableActions(row('sending'), { canSend: true })).toEqual(['open', 'pause', 'duplicate', 'delete']);
    expect(availableActions(row('paused'), { canSend: true })).toEqual(['open', 'resume', 'duplicate', 'delete']);
    expect(availableActions(row('sent', { failed_count: 3 }), { canSend: true })).toEqual(['open', 'retryFailed', 'duplicate', 'delete']);
    expect(availableActions(row('sent'), { canSend: true })).toEqual(['open', 'duplicate', 'delete']);
  });

  it('never offers a sending action to a member without campaigns.send', () => {
    for (const status of ['draft', 'scheduled', 'sending', 'paused', 'sent'] as const)
      expect(availableActions(row(status, { failed_count: 2 }), { canSend: false })).toEqual(['open']);
    expect(primaryAction(row('scheduled'), false)).toBeNull();
  });

  it('cannot pause or duplicate an API campaign, and leaves the open action out of the campaign page', () => {
    expect(availableActions(row('sending', { kind: 'api' }), { canSend: true, inDetail: true })).toEqual(['delete']);
    expect(primaryAction(row('sending', { kind: 'api' }), true)).toBeNull();
  });

  it('leads the campaign page with the next step for its status', () => {
    expect(primaryAction(row('draft'), true)).toBe('edit');
    expect(primaryAction(row('scheduled'), true)).toBe('sendNow');
    expect(primaryAction(row('sending'), true)).toBe('pause');
    expect(primaryAction(row('paused'), true)).toBe('resume');
    expect(primaryAction(row('failed', { failed_count: 10 }), true)).toBe('retryFailed');
    expect(primaryAction(row('sent'), true)).toBeNull();
  });
});

describe('campaign row display', () => {
  it('shows progress only once sending started', () => {
    expect(broadcastStarted('draft')).toBe(false);
    expect(broadcastStarted('scheduled')).toBe(false);
    expect(broadcastStarted('paused')).toBe(true);
    expect(sentPercent({ sent_count: 4, failed_count: 1, total_recipients: 10 })).toBe(50);
    expect(sentPercent({ sent_count: 0, failed_count: 0, total_recipients: 0 })).toBe(0);
  });

  it('names when a campaign sends or sent', () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? `:${Object.keys(values).join(',')}` : ''}`;
    expect(broadcastWhen({ status: 'draft', created_at: '2026-11-01T10:00:00Z' }, t)).toBe('when.draft');
    expect(broadcastWhen({ status: 'scheduled', scheduled_at: '2026-11-14T09:00:00Z', created_at: '' }, t)).toBe('when.scheduled:when');
    expect(broadcastWhen({ status: 'paused', created_at: '' }, t)).toBe('when.paused');
    expect(broadcastWhen({ status: 'failed', created_at: '2026-11-01T10:00:00Z' }, t)).toBe('when.sent:when');
  });
});

describe('the report message preview', () => {
  it('fills fixed values and names per-contact ones, in placeholder order', () => {
    expect(bodySamples({
      '2': { type: 'static', value: '20%' },
      '1': { type: 'field', value: 'name' },
      '3': { type: 'custom_field', value: '00000000-0000-4000-8000-000000000000' },
      _send: { coupon: 'X' },
    }, { customField: 'custom field' })).toEqual(['{name}', '20%', '{custom field}']);
    expect(bodySamples(undefined, { customField: 'x' })).toEqual([]);
  });
});

describe('wizard prefill from Duplicate or a draft', () => {
  const source = {
    name: 'Festive offer',
    template_name: 'festive', template_language: 'en_US',
    template_variables: { '1': { type: 'field', value: 'name' }, '2': { type: 'static', value: '20%' }, _send: { coupon_code: 'SAVE20' }, bad: 'x' },
    audience_filter: { type: 'tags', tagIds: ['t1'], excludeTagIds: ['t2'] },
  };

  it('copies the template, mappings, fixed values and audience under a copy name', () => {
    const p = prefillFromBroadcast(source, (n) => `${n} copy`);
    expect(p).toMatchObject({
      name: 'Festive offer copy', channel: 'whatsapp', templateName: 'festive', templateLanguage: 'en_US',
      variables: { '1': { type: 'field', value: 'name' }, '2': { type: 'static', value: '20%' } },
      audience: { type: 'tags', tagIds: ['t1'], excludeTagIds: ['t2'] },
    });
    expect(p.variables).not.toHaveProperty('bad');
  });

  it('keeps a draft name, and an Instagram campaign keeps its text and no template', () => {
    const p = prefillFromBroadcast({ name: 'IG', channel: 'instagram', message_text: 'Hi {first name}', template_name: '', audience_filter: { type: 'all' } });
    expect(p).toMatchObject({ name: 'IG', channel: 'instagram', text: 'Hi {first name}', templateName: null, variables: {}, audience: { type: 'all' } });
  });

  it('starts a CSV campaign copy from All contacts and drops CSV-column mappings', () => {
    const p = prefillFromBroadcast({
      name: 'CSV', template_name: 'x', template_variables: { '1': { type: 'csv_column', value: 'city' } }, audience_filter: { type: 'csv' },
    });
    expect(p.audience).toEqual({ type: 'all' });
    expect(p.variables).toEqual({});
  });
});
