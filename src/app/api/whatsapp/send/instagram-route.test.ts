// The inbox send route's Instagram branch (Phase 11): the channel comes from
// the conversation row, never from the client; Instagram goes through the
// composer sender only while Instagram is on; a WhatsApp row never does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: { id: 'conv-1', channel: 'instagram' as string | null },
  composer: vi.fn(),
  sendWhatsApp: vi.fn(),
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

import { POST } from './route';
import { InstagramDeliveryUncertainError } from '@/lib/instagram/composer-send';
import { InstagramError } from '@/lib/instagram/errors';
import { ChannelUnavailableError } from '@/lib/channels/sender';

const env = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 's',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'v', APP_URL: 'https://app.example.test',
};
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/whatsapp/send', { method: 'POST', body: JSON.stringify(body) }));
const text = { conversation_id: 'conv-1', message_type: 'text', content_text: 'hello' };

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { id: 'conv-1', channel: 'instagram' };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  h.composer.mockResolvedValue({ messageId: 'msg-1', providerMessageId: 'mid-1' });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/whatsapp/send on an Instagram conversation', () => {
  it('answers instagram_not_enabled while Instagram is off, calling nothing', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    const res = await send(text);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('instagram_not_enabled');
    expect(h.composer).not.toHaveBeenCalled();
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('sends through the Instagram composer with the row id and claims the conversation', async () => {
    const res = await send({ ...text, conversation_id: 'conv-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message_id: 'msg-1', provider_message_id: 'mid-1' });
    expect(h.composer).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct-1', userId: 'user-1', conversationId: 'conv-1', messageType: 'text', contentText: 'hello',
    }));
    expect(h.claim).toHaveBeenCalled();
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied channel: a WhatsApp row goes to the WhatsApp sender', async () => {
    h.row = { id: 'conv-1', channel: 'whatsapp' };
    h.sendWhatsApp.mockResolvedValue({ messageId: 'wa-1', whatsappMessageId: 'wamid', message: {} });
    await send({ ...text, channel: 'instagram' });
    expect(h.composer).not.toHaveBeenCalled();
    expect(h.sendWhatsApp).toHaveBeenCalled();
  });

  it('maps refusals to fixed codes', async () => {
    h.composer.mockRejectedValueOnce(new InstagramError('instagram_window_closed'));
    let res = await send(text);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('instagram_window_closed');
    h.composer.mockRejectedValueOnce(new ChannelUnavailableError('template'));
    res = await send({ ...text, message_type: 'template', template_name: 'x' });
    expect((await res.json()).error).toBe('channel_not_supported');
  });

  it('reports an uncertain delivery with its stored row, never as a plain failure', async () => {
    h.composer.mockRejectedValueOnce(new InstagramDeliveryUncertainError('msg-9'));
    const res = await send(text);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'delivery_uncertain', message_id: 'msg-9' });
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/send with a saved Instagram template', () => {
  const template = { conversation_id: 'conv-1', message_type: 'ig_template', template_id: '55555555-5555-4555-8555-555555555555' };

  it('passes the template id to the Instagram composer sender', async () => {
    const res = await send(template);
    expect(res.status).toBe(200);
    expect(h.composer).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct-1', conversationId: 'conv-1', messageType: 'ig_template', templateId: template.template_id,
    }));
  });

  it('never sends one into a WhatsApp conversation', async () => {
    h.row = { id: 'conv-1', channel: 'whatsapp' };
    const res = await send(template);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.composer).not.toHaveBeenCalled();
    expect(h.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('needs a conversation', async () => {
    const res = await send({ message_type: 'ig_template', template_id: template.template_id });
    expect(res.status).toBe(400);
    expect(h.composer).not.toHaveBeenCalled();
  });
});
