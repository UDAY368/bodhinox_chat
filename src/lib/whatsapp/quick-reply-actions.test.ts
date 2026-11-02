import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ automation: vi.fn(), flow: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationById: h.automation }));
vi.mock('@/lib/flows/engine', () => ({ startFlowById: h.flow }));
import { dispatchQuickReplyAction } from './quick-reply-actions';
import type { DataClient } from '@/lib/data/types';

const token = 'qr_00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const input = { accountId: 'account', conversationId: 'conversation', contactId: 'contact', userId: 'user', messageId: 'inbound', metaMessageId: 'wamid.tap', interactiveReplyId: token };
function database(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, Record<string, unknown>[]> = {
    messages: [
      { id: 'inbound', account_id: 'account', conversation_id: 'conversation', sender_type: 'customer', reply_to_message_id: 'outbound', interactive_reply_id: token },
      { id: 'outbound', account_id: 'account', conversation_id: 'conversation', sender_type: 'agent', interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'automation', targetId } }] }, ...overrides },
    ], conversations: [{ id: 'conversation', account_id: 'account', contact_id: 'contact', bot_paused: true, updated_at: '2026-01-01T00:00:00.000Z' }],
    automations: [{ id: targetId, account_id: 'account', is_active: true }],
    flows: [{ id: targetId, account_id: 'account', status: 'active', entry_node_id: 'start' }], flow_runs: [],
  };
  const updates: unknown[] = [];
  let databaseVersion = 0;
  const db = { from(table: string) {
    let filtered = rows[table] ?? [];
    let patch: unknown;
    function result() {
      if (patch && filtered.length) {
        updates.push(patch);
        // The CRM repository and PostgreSQL trigger override caller updated_at.
        // Preserve all six fractional digits, matching the JSON SQL projection.
        const authoritativeAt = `2026-10-19T01:00:${String(++databaseVersion).padStart(2, '0')}.123456+00:00`;
        filtered.forEach(row => Object.assign(row, patch, { updated_at: authoritativeAt }));
      }
      return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
    }
    const b = { select: () => b, eq: (key: string, value: unknown) => { filtered = filtered.filter(row => row[key] === value); return b; },
      limit: () => b,
      update: (value: unknown) => { patch = value; return b; },
      maybeSingle: async () => result(),
      then: (resolve: (result: unknown) => unknown) => { result(); return Promise.resolve({ data: filtered, error: null }).then(resolve); },
    }; return b;
  } } as unknown as DataClient;
  return { db, rows, updates };
}
beforeEach(() => { vi.clearAllMocks(); h.automation.mockResolvedValue({ outcome: 'started' }); h.flow.mockResolvedValue({ outcome: 'started' }); });
it('executes only the workflow bound to the exact persisted outbound parent and resumes the bot', async () => {
  const { db, updates } = database();
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'started' });
  expect(h.automation).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account', automationId: targetId, contactId: 'contact', context: expect.objectContaining({ conversation_id: 'conversation' }) }));
  expect(updates).toContainEqual(expect.objectContaining({ bot_paused: false }));
  expect(h.flow).not.toHaveBeenCalled();
});
it.each([{ account_id: 'foreign' }, { conversation_id: 'foreign' }, { sender_type: 'customer' }, { interactive_payload: { kind: 'buttons', buttons: [{ id: 'wrong', action: { type: 'automation', targetId: 'target' } }] } }])('ignores a mismatched or untrusted outbound parent: %j', async (override) => {
  const { db, updates } = database(override);
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: false });
  expect(h.automation).not.toHaveBeenCalled(); expect(updates).toEqual([]);
});
it('does not resolve a token without an exact persisted parent', async () => {
  const { db, rows } = database(); rows.messages[0].reply_to_message_id = null;
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: false });
});
it('refuses a token that disagrees with the persisted inbound reply', async () => {
  const { db, rows } = database(); rows.messages[0].interactive_reply_id = 'another';
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: false });
  expect(h.automation).not.toHaveBeenCalled();
});
it('never starts a workflow for a different contact in the conversation', async () => {
  const { db } = database();
  expect(await dispatchQuickReplyAction(db, { ...input, contactId: 'foreign' })).toEqual({ handled: true, outcome: 'unavailable' });
  expect(h.automation).not.toHaveBeenCalled();
});
it('does not dispatch URL actions as workflows', async () => {
  const { db } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'url', url: 'https://example.com' } }] } });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: false });
  expect(h.automation).not.toHaveBeenCalled(); expect(h.flow).not.toHaveBeenCalled();
});
it('propagates uncertain execution errors to the durable inbound stage', async () => {
  h.automation.mockRejectedValue(new Error('uncertain'));
  await expect(dispatchQuickReplyAction(database().db, input)).rejects.toThrow('uncertain');
});
it('consumes a recognized action whose target has become unavailable', async () => {
  h.automation.mockResolvedValue({ outcome: 'unavailable' });
  const { db, rows } = database();
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'unavailable' });
  expect(rows.conversations[0].bot_paused).toBe(true);
});
it('starts a selected flow directly without trigger matching', async () => {
  const { db } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'flow', targetId } }] } });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'started' });
  expect(h.flow).toHaveBeenCalledWith(expect.objectContaining({ flowId: targetId, accountId: 'account', conversationId: 'conversation' }));
});
it.each(['deleted', 'inactive', 'foreign'])('preserves the paused conversation for an unavailable %s target', async kind => {
  const { db, rows, updates } = database();
  if (kind === 'deleted') rows.automations.length = 0;
  else if (kind === 'inactive') rows.automations[0].is_active = false;
  else rows.automations[0].account_id = 'foreign';
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'unavailable' });
  expect(rows.conversations[0].bot_paused).toBe(true); expect(updates).toEqual([]); expect(h.automation).not.toHaveBeenCalled();
});
it('consumes malformed stored target IDs without querying targets or unpausing', async () => {
  const { db, updates } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'automation', targetId: 'malformed' } }] } });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'unavailable' });
  expect(updates).toEqual([]); expect(h.automation).not.toHaveBeenCalled();
});
it('preserves the human handoff when another flow is active', async () => {
  const { db, rows, updates } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'flow', targetId } }] } });
  rows.flow_runs.push({ id: 'other', account_id: 'account', contact_id: 'contact', conversation_id: 'conversation', status: 'active' });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'conflict' });
  expect(updates).toEqual([]); expect(h.flow).not.toHaveBeenCalled(); expect(rows.conversations[0].bot_paused).toBe(true);
});
it("starts the flow when the contact's only active run is on another number's conversation", async () => {
  const { db, rows } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'flow', targetId } }] } });
  rows.flow_runs.push({ id: 'number-a-run', account_id: 'account', contact_id: 'contact', conversation_id: 'conversation-on-number-a', status: 'active' });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'started' });
  expect(h.flow).toHaveBeenCalledWith(expect.objectContaining({ flowId: targetId, contactId: 'contact', conversationId: 'conversation' }));
  expect(rows.flow_runs[0].status).toBe('active');
});
it('restores the paused state if a concurrent flow start wins after preflight', async () => {
  const { db, rows } = database({ interactive_payload: { kind: 'buttons', buttons: [{ id: token, action: { type: 'flow', targetId } }] } });
  h.flow.mockResolvedValue({ outcome: 'conflict' });
  expect(await dispatchQuickReplyAction(db, input)).toEqual({ handled: true, outcome: 'conflict' });
  expect(rows.conversations[0].bot_paused).toBe(true);
});
it('uses the exact database-returned timestamp for restoration when the database overrides the caller timestamp', async () => {
  const { db, rows } = database();
  h.automation.mockImplementation(async () => {
    expect(rows.conversations[0].updated_at).toBe('2026-10-19T01:00:01.123456+00:00');
    return { outcome: 'unavailable' };
  });
  await dispatchQuickReplyAction(db, input);
  expect(rows.conversations[0].bot_paused).toBe(true);
  expect(rows.conversations[0].updated_at).toBe('2026-10-19T01:00:02.123456+00:00');
});
it('preserves a concurrent human state change when restoring a target that became unavailable', async () => {
  const { db, rows } = database();
  h.automation.mockImplementation(async () => { Object.assign(rows.conversations[0], { bot_paused: false, updated_at: 'later-human-write' }); return { outcome: 'unavailable' }; });
  await dispatchQuickReplyAction(db, input);
  expect(rows.conversations[0].bot_paused).toBe(false); expect(rows.conversations[0].updated_at).toBe('later-human-write');
});
