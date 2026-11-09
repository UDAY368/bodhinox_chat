/**
 * A scheduled automation's contact steps act on one conversation: with one
 * conversation per (contact, number), a contact on two numbers resolves to
 * the default number's thread instead of failing the job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

const run = vi.hoisted(() => ({ trigger: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined) }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: run.trigger }));
vi.mock('./dispatch', () => ({ dispatchOnce: async (_a: string, _k: string, work: () => Promise<unknown>) => work() }));
vi.mock('./queue', () => ({ enqueueJob: vi.fn() }));


import { executeScheduledOccurrence } from './scheduled-audience';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SLOT = '2026-11-02T09:00:00.000Z';

let conversations: Record<string, unknown>[] = [];
let inserts: Record<string, unknown>[] = [];
let contact: Record<string, unknown> = {};

function fakeDb(): DataClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      const result = () => {
        if (table === 'automations') return { data: { id: 'auto', user_id: 'u', is_active: true, trigger_type: 'time_based', trigger_config: {} }, error: null };
        if (table === 'automation_steps') return { data: [{ step_type: 'send_message', step_config: {} }], error: null };
        if (table === 'contacts') return { data: contact, error: null };
        if (table === 'whatsapp_config') return { data: [{ id: A, is_default: true, created_at: '2026-01-01' }, { id: B, is_default: false, created_at: '2026-02-01' }], error: null };
        if (table === 'conversations') return { data: conversations, error: null };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => result();
      b.single = async () => result();
      b.insert = async (row: Record<string, unknown>) => {
        inserts.push(row);
        conversations = [{ id: 'created', whatsapp_config_id: A }];
        return { error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return b;
    },
  } as unknown as DataClient;
}

beforeEach(() => {
  conversations = [];
  inserts = [];
  contact = { id: 'contact', phone: '+14155550101', wa_user_id: null };
  run.trigger.mockClear();
});

const conversationOfRun = () => (run.trigger.mock.calls[0][0] as { context: { conversation_id?: string } }).context.conversation_id;

describe('executeScheduledOccurrence with two numbers', () => {
  it("runs on the default number's conversation when the contact has one on each number", async () => {
    conversations = [{ id: 'on-b', whatsapp_config_id: B }, { id: 'on-a', whatsapp_config_id: A }];
    await executeScheduledOccurrence(fakeDb(), 'acct', 'auto', SLOT, 'contact', () => {});
    expect(conversationOfRun()).toBe('on-a');
    expect(inserts).toHaveLength(0);
  });

  it('keeps the single conversation of a single-number contact', async () => {
    conversations = [{ id: 'only', whatsapp_config_id: A }];
    await executeScheduledOccurrence(fakeDb(), 'acct', 'auto', SLOT, 'contact', () => {});
    expect(conversationOfRun()).toBe('only');
  });

  it('opens a conversation when the contact has none, then runs on it', async () => {
    await executeScheduledOccurrence(fakeDb(), 'acct', 'auto', SLOT, 'contact', () => {});
    expect(inserts).toHaveLength(1);
    expect(conversationOfRun()).toBe('created');
  });
});

describe('executeScheduledOccurrence for a contact with no WhatsApp address', () => {
  it('opens no WhatsApp conversation for an Instagram-only contact and runs without one', async () => {
    contact = { id: 'contact', phone: '', wa_user_id: null };
    // Its only conversation is on Instagram, which the WhatsApp pick ignores.
    conversations = [{ id: 'ig', whatsapp_config_id: null, channel: 'instagram' }];
    await executeScheduledOccurrence(fakeDb(), 'acct', 'auto', SLOT, 'contact', () => {});
    expect(inserts).toHaveLength(0);
    expect(run.trigger).toHaveBeenCalledTimes(1);
    expect(conversationOfRun()).toBeUndefined();
  });

  it('still opens one for a contact reachable only by business-scoped user id', async () => {
    contact = { id: 'contact', phone: '', wa_user_id: 'US.13491208655302741918' };
    await executeScheduledOccurrence(fakeDb(), 'acct', 'auto', SLOT, 'contact', () => {});
    expect(inserts).toHaveLength(1);
    expect(conversationOfRun()).toBe('created');
  });
});
