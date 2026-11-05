// The inbox send route records which AI suggested reply a sent text used
// (Phase 13). Recording happens only after the send succeeded, is
// best-effort, and never changes, blocks or fails the send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: { id: '33333333-3333-4333-8333-333333333333', channel: 'whatsapp' as string | null },
  sendWhatsApp: vi.fn(),
  composer: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(async () => true),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq']) chain[m] = () => chain;
  chain.single = async () => ({ data: h.row, error: null });
  return { ...actual, requireRole: async () => ({ db: chain, accountId: 'acct-1', userId: 'user-1', role: 'agent' }) };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: () => ({ success: true }) };
});
vi.mock('@/lib/inbox/lifecycle', () => ({ claimOnAgentReply: h.claim }));
vi.mock('@/lib/platform/lifecycle', () => ({ manualRepliesBlocked: async () => false }));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/send-message')>();
  return { ...actual, sendMessageToConversation: h.sendWhatsApp };
});
vi.mock('@/lib/instagram/composer-send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/instagram/composer-send')>();
  return { ...actual, sendInstagramFromComposer: h.composer };
});
vi.mock('@/lib/ai/assist/suggestions', () => ({ recordSuggestionUse: h.record }));

import { POST } from './route';
import { SendMessageError } from '@/lib/whatsapp/send-message';

const CONV = '33333333-3333-4333-8333-333333333333';
const SUGGESTION = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/whatsapp/send', { method: 'POST', body: JSON.stringify(body) }));
const text = { conversation_id: CONV, message_type: 'text', content_text: 'We open at 10.', ai_suggestion_id: SUGGESTION };

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { id: CONV, channel: 'whatsapp' };
  h.sendWhatsApp.mockResolvedValue({ messageId: MESSAGE, whatsappMessageId: 'wamid.1' });
  h.composer.mockResolvedValue({ messageId: MESSAGE, providerMessageId: 'mid-1' });
  h.record.mockResolvedValue({ status: 'accepted', editDistance: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('POST /api/whatsapp/send with ai_suggestion_id', () => {
  it('records the suggestion after the send, as the sender, with the stored message id', async () => {
    const res = await send(text);
    expect(res.status).toBe(200);
    expect(h.record).toHaveBeenCalledWith(
      { accountId: 'acct-1', userId: 'user-1', role: 'agent' },
      { suggestionId: SUGGESTION, conversationId: CONV, messageId: MESSAGE, sentText: 'We open at 10.' },
    );
    expect(h.sendWhatsApp.mock.invocationCallOrder[0]).toBeLessThan(h.record.mock.invocationCallOrder[0]);
    // The send itself is unchanged: no suggestion id reaches the send core.
    expect(JSON.stringify(h.sendWhatsApp.mock.calls[0])).not.toContain(SUGGESTION);
  });

  it('still reports the send when recording fails, and logs no message text', async () => {
    h.record.mockRejectedValueOnce(new Error('We open at 10. db down'));
    const res = await send(text);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, message_id: MESSAGE });
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain('We open');
  });

  it('records nothing when the send failed', async () => {
    h.sendWhatsApp.mockRejectedValueOnce(new SendMessageError('session_expired', 'window closed', 400));
    expect((await send(text)).status).toBe(400);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('ignores an invalid id and non-text sends', async () => {
    await send({ ...text, ai_suggestion_id: 'not-a-uuid' });
    await send({ ...text, ai_suggestion_id: 42 });
    await send({ conversation_id: CONV, message_type: 'image', media_url: 'https://x.test/a.png', ai_suggestion_id: SUGGESTION });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('records on an Instagram text send too', async () => {
    for (const [k, v] of Object.entries({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 's',
      INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'v', APP_URL: 'https://app.example.test' })) vi.stubEnv(k, v);
    h.row = { id: CONV, channel: 'instagram' };
    expect((await send(text)).status).toBe(200);
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }),
      expect.objectContaining({ suggestionId: SUGGESTION, messageId: MESSAGE }));
  });
});
