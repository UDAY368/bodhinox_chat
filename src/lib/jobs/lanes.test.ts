import { describe, expect, it } from 'vitest';
import {
  BULK_JOB_TYPES, conversationLaneKey, DEFAULT_LANE_SLOTS, idleDelayMs, jobLane, laneIdleMaxMs, laneSlots, TIMER_JOB_TYPES,
  webhookLaneKey, workerConnections, workerLanes,
} from './lanes';

describe('worker lanes', () => {
  it('puts each job type in exactly one lane; unknown types run inbound', () => {
    expect(BULK_JOB_TYPES.filter((t) => (TIMER_JOB_TYPES as readonly string[]).includes(t))).toEqual([]);
    for (const type of ['whatsapp.webhook', 'inbound.actions', 'instagram.webhook', 'instagram.private_reply', 'meta.page_webhook',
      'events.dispatch', 'webhook.delivery', 'ai.auto_reply_retry', 'ai.assess_conversation', 'api.start_flow', 'flow.replay',
      'payments.razorpay_event', 'a.type_added_later']) expect(jobLane(type)).toBe('inbound');
    for (const type of ['flow.timer', 'flow.sweep', 'automation.schedule', 'automation.resume', 'inbox.sla_check', 'data.retention_sweep',
      'ai.retention_sweep', 'appointments.reminder', 'sequences.due', 'payments.reconcile_sweep']) expect(jobLane(type)).toBe('timers');
    for (const type of ['broadcast.dispatch', 'workspace.export', 'instagram.profile_fetch', 'instagram.token_sweep',
      'instagram.resubscribe', 'meta.insights_sync', 'commerce.meta_catalogue_sync']) expect(jobLane(type)).toBe('bulk');
  });

  it('reads per-lane slot counts (1 to 8) and keeps the defaults inside a pool of 10', () => {
    expect(laneSlots({})).toEqual(DEFAULT_LANE_SLOTS);
    // A small pool with no slot counts set: one slot per lane; counts that are set are honoured.
    expect(laneSlots({ DB_POOL_SIZE: '5' })).toEqual({ inbound: 1, timers: 1, bulk: 1 });
    expect(laneSlots({ DB_POOL_SIZE: '5', WORKER_INBOUND_SLOTS: '2' })).toEqual({ inbound: 2, timers: 1, bulk: 2 });
    expect(laneSlots({ DB_POOL_SIZE: '9' })).toEqual(DEFAULT_LANE_SLOTS);
    expect(workerConnections(DEFAULT_LANE_SLOTS)).toBeLessThanOrEqual(10);
    expect(laneSlots({ WORKER_INBOUND_SLOTS: '4', WORKER_TIMER_SLOTS: ' 2 ', WORKER_BULK_SLOTS: '1' })).toEqual({ inbound: 4, timers: 2, bulk: 1 });
    for (const bad of ['0', '9', '-1', '1.5', 'x', '']) expect(laneSlots({ WORKER_INBOUND_SLOTS: bad }).inbound).toBe(2);
    expect(workerLanes({})).toEqual(['inbound', 'inbound', 'timers', 'bulk', 'bulk']);
    expect(workerLanes({ WORKER_CONCURRENCY: '1', WORKER_INBOUND_SLOTS: '4' })).toEqual(['all']);
    // Any other WORKER_CONCURRENCY (an older setting such as 3) uses the lanes.
    expect(workerLanes({ WORKER_CONCURRENCY: '3', WORKER_BULK_SLOTS: '1' })).toEqual(['inbound', 'inbound', 'timers', 'bulk']);
  });

  it('backs off idle polling from 250 ms to the lane maximum and resets on work', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((m) => idleDelayMs(m))).toEqual([0, 250, 500, 1000, 2000, 4000, 5000, 5000]);
    expect(idleDelayMs(10, 250, laneIdleMaxMs('inbound'))).toBe(2000);
    expect(laneIdleMaxMs('bulk')).toBe(5000);
    expect(laneIdleMaxMs('timers')).toBe(5000);
  });

  it('keys a webhook delivery by its one chat, else leaves it unkeyed', () => {
    const delivery = (values: Record<string, unknown>[]) => ({ entry: [{ id: 'waba', changes: values.map((value) => ({ field: 'messages', value })) }] });
    const meta = { phone_number_id: '1001' };
    expect(webhookLaneKey(delivery([{ metadata: meta, messages: [{ from: '9199', id: 'a' }, { from: '9199', id: 'b' }] }]))).toBe('wa:1001:9199');
    expect(webhookLaneKey(delivery([{ metadata: meta, statuses: [{ recipient_id: '9199', id: 'x' }] }]))).toBe('wa:1001:9199');
    expect(webhookLaneKey(delivery([{ metadata: meta, messages: [{ from: '9199' }] }, { metadata: meta, messages: [{ from: '9188' }] }]))).toBeNull();
    expect(webhookLaneKey(delivery([{ metadata: { phone_number_id: '2002' }, messages: [{ from: '9199' }] }, { metadata: meta, statuses: [{ recipient_id: '9199' }] }]))).toBeNull();
    expect(webhookLaneKey(delivery([{ metadata: meta, messages: [{ from: 42 }] }]))).toBeNull();
    expect(webhookLaneKey(delivery([{ message_template_id: 7, event: 'APPROVED' }]))).toBeNull();
    expect(webhookLaneKey({})).toBeNull();
    expect(webhookLaneKey(delivery([{ metadata: meta, messages: [{ from: '9'.repeat(300) }] }]))).toBeNull();
    expect(conversationLaneKey('c-1')).toBe('conversation:c-1');
  });
});
