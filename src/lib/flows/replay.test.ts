import { describe, expect, it } from 'vitest';
import { isUniqueViolation, likePrefix, parseIntentKey, REPLAYABLE_END_REASONS, replayEligibility, type ReplayRunState } from './replay';

const now = new Date('2026-11-04T12:00:00Z');
const run = (over: Partial<ReplayRunState> = {}): ReplayRunState => ({
  status: 'failed', ended_at: '2026-11-04T10:00:00Z', end_reason: 'send_text_failed', contact_id: 'c', conversation_id: 'v',
  flow_version_id: 'ver', ...over,
});
const check = (over: Partial<Parameters<typeof replayEligibility>[0]> = {}) =>
  replayEligibility({ run: run(), flowStatus: 'active', failedNode: 'hello', nodeIntents: [{ status: 'failed' }], conversationBusy: false, now, ...over });

describe('replayEligibility', () => {
  it('allows a recent transient send failure whose send was refused, or never claimed', () => {
    expect(check()).toEqual({ ok: true });
    expect(check({ nodeIntents: [] })).toEqual({ ok: true });
    expect(check({ flowStatus: 'paused' })).toEqual({ ok: true });
  });

  it('never re-sends after an ambiguous or accepted send', () => {
    for (const status of ['pending', 'dispatching', 'unknown']) {
      expect(check({ nodeIntents: [{ status: 'failed' }, { status }] })).toEqual({ ok: false, reason: 'needs_reconciliation' });
    }
    expect(check({ nodeIntents: [{ status: 'accepted' }] })).toEqual({ ok: false, reason: 'already_sent' });
    expect(check({ nodeIntents: [{ status: 'weird' }] })).toEqual({ ok: false, reason: 'needs_reconciliation' });
  });

  it('refuses business outcomes, half-done bookings and graph defects', () => {
    for (const reason of ['payment_link_failed', 'payment_link_rejected', 'book_appointment_failed', 'node_not_found',
      'missing_next_node', 'unknown_node_type', 'advance_loop_overflow', 'condition_evaluation_failed', 'connect_flow_loop',
      'connect_flow_unavailable', 'api_request_failed', null]) {
      expect(check({ run: run({ end_reason: reason }) })).toEqual({ ok: false, reason: 'not_replayable_reason' });
    }
    expect(check({ failedNode: null })).toEqual({ ok: false, reason: 'not_replayable_reason' });
    expect(REPLAYABLE_END_REASONS.has('delay_schedule_failed')).toBe(true);
  });

  it('replays a storefront link only when its send failed', () => {
    const storefront = (failedReason: string | null) => check({ run: run({ end_reason: 'storefront_link_failed' }), failedReason });
    expect(storefront('storefront_link_send_failed')).toEqual({ ok: true });
    for (const reason of ['storefront_link_invalid_config', 'storefront_link_no_order', 'storefront_link_storefront_disabled',
      'storefront_link_workspace_suspended', null]) {
      expect(storefront(reason)).toEqual({ ok: false, reason: 'not_replayable_reason' });
    }
  });

  it('refuses runs that did not fail, are old, have no conversation, are unpinned, archived or blocked by another run', () => {
    expect(check({ run: run({ status: 'completed' }) })).toEqual({ ok: false, reason: 'not_failed' });
    expect(check({ run: run({ ended_at: '2026-10-27T11:59:00Z' }) })).toEqual({ ok: false, reason: 'too_old' });
    expect(check({ run: run({ ended_at: null }) })).toEqual({ ok: false, reason: 'too_old' });
    expect(check({ run: run({ conversation_id: null }) })).toEqual({ ok: false, reason: 'no_contact' });
    expect(check({ flowStatus: 'archived' })).toEqual({ ok: false, reason: 'flow_archived' });
    expect(check({ run: run({ flow_version_id: null }) })).toEqual({ ok: false, reason: 'not_pinned' });
    expect(check({ conversationBusy: true })).toEqual({ ok: false, reason: 'conversation_busy' });
  });

  it('refuses a contact who sent STOP since the failure (audit #47)', () => {
    expect(check({ contactOptedOut: true })).toEqual({ ok: false, reason: 'contact_opted_out' });
    expect(check({ contactOptedOut: false })).toEqual({ ok: true });
  });
});

describe('intent keys', () => {
  const A = 'acct', R = 'run';
  it('parses the fixed fields of each kind and ignores other runs', () => {
    expect(parseIntentKey('acct:flow:run:hello:3:0', A, R)).toEqual({ kind: 'flow', node_key: 'hello', seq: 3, attempt: 0, part: null });
    expect(parseIntentKey('acct:flow:run:media:1:0:caption', A, R)).toMatchObject({ node_key: 'media', part: 'caption' });
    expect(parseIntentKey('acct:flow:run:shop:2:storefront_link', A, R)).toEqual({ kind: 'flow', node_key: 'shop', seq: 2, attempt: null, part: 'storefront_link' });
    expect(parseIntentKey('acct:flow-api:run:crm:1:0', A, R)).toMatchObject({ kind: 'flow-api', node_key: 'crm' });
    expect(parseIntentKey('acct:flow-ai:run:wamid.X', A, R)).toEqual({ kind: 'flow-ai', node_key: null, seq: null, attempt: null, part: null });
    expect(parseIntentKey('acct:flow:other:hello:3:0', A, R)).toBeNull();
    expect(parseIntentKey('other:flow:run:hello:3:0', A, R)).toBeNull();
  });

  it('escapes LIKE wildcards in a node key', () => {
    expect(likePrefix('a:flow:r:ask_1:2:')).toBe('a:flow:r:ask\\_1:2:%');
    expect(likePrefix('50%\\')).toBe('50\\%\\\\%');
  });

  it('recognises a unique violation from Prisma or pg', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "x"'))).toBe(true);
    expect(isUniqueViolation(new Error('timeout'))).toBe(false);
  });
});
