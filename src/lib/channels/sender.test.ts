import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  ChannelUnavailableError,
  checkInstagramChoices,
  checkInstagramMedia,
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramText,
  storeInstagramSentMessage,
  type InstagramTarget,
} from './sender';

const ENV = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test',
};
const now = new Date('2026-11-10T12:00:00Z');
const target = (hoursAgo: number | null): InstagramTarget => ({
  accountId: 'a', conversationId: 'c', contactId: 'k', instagramAccountId: 'i', igUserId: '111', igsid: '222',
  accessTokenEnc: encrypt('test-only-ig-token'), scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
  lastCustomerAt: hoursAgo === null ? null : new Date(now.getTime() - hoursAgo * 3_600_000),
  adReferralAt: null,
});
const fetchMock = vi.fn();

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('instagram sender checks', () => {
  it('refuses everything while Instagram is off, before any request', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    expect(() => checkInstagramText(target(1), 'hi', { sender: 'automated', now })).toThrow(expect.objectContaining({ code: 'instagram_not_enabled' }));
    await expect(sendInstagramText(target(1), 'hi', { sender: 'automated', now })).rejects.toMatchObject({ code: 'instagram_not_enabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses outside the window and over-long text before any request', () => {
    expect(() => checkInstagramText(target(25), 'hi', { sender: 'automated', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
    expect(() => checkInstagramText(target(null), 'hi', { sender: 'staff', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
    expect(() => checkInstagramText(target(1), 'x'.repeat(1001), { sender: 'staff', now })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(checkInstagramText(target(1), 'hi', { sender: 'automated', now })).toEqual({ humanAgentTag: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tags a staff reply between 24 h and 7 days only with the Human Agent flag', () => {
    expect(() => checkInstagramText(target(48), 'hi', { sender: 'staff', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
    vi.stubEnv('INSTAGRAM_HUMAN_AGENT_ENABLED', 'true');
    expect(checkInstagramText(target(48), 'hi', { sender: 'staff', now })).toEqual({ humanAgentTag: true });
    expect(() => checkInstagramText(target(48), 'hi', { sender: 'automated', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
  });

  it('lets an automated send through for 7 days after a click-to-Direct ad message, only with the flag', () => {
    const adTarget = { ...target(72), adReferralAt: new Date(now.getTime() - 72 * 3_600_000) };
    expect(() => checkInstagramText(adTarget, 'hi', { sender: 'automated', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
    vi.stubEnv('INSTAGRAM_CTD_WINDOW_ENABLED', 'true');
    expect(checkInstagramText(adTarget, 'hi', { sender: 'automated', now })).toEqual({ humanAgentTag: false });
    const old = { ...adTarget, adReferralAt: new Date(now.getTime() - 8 * 24 * 3_600_000) };
    expect(() => checkInstagramText(old, 'hi', { sender: 'automated', now })).toThrow(expect.objectContaining({ code: 'instagram_window_closed' }));
  });

  it('refuses media and choices Instagram cannot carry', () => {
    expect(() => checkInstagramMedia(target(1), { type: 'sticker' as never, url: 'https://x.test/a' }, { sender: 'staff', now }))
      .toThrow(ChannelUnavailableError);
    expect(() => checkInstagramMedia(target(1), { type: 'image', url: 'http://x.test/a.png' }, { sender: 'staff', now }))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
    const many = Array.from({ length: 14 }, (_, i) => ({ title: `t${i}`, payload: `p${i}` }));
    expect(() => checkInstagramChoices(target(1), 'Pick', many, { sender: 'automated', now })).toThrow(ChannelUnavailableError);
  });

  it('sends with the decrypted token in the header and returns the mid', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message_id: 'mid.1', recipient_id: '222' }), { status: 200 }));
    await expect(sendInstagramText(target(1), 'hi', { sender: 'automated', now })).resolves.toEqual({ messageId: 'mid.1', recipientId: '222' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-only-ig-token');
  });

  it('refuses an https URL that sendAttachment would reject, before any intent', () => {
    for (const url of ['https://exa mple.com/a.png', 'https://', `https://x.test/${'a'.repeat(2048)}`])
      expect(() => checkInstagramMedia(target(1), { type: 'image', url }, { sender: 'staff', now }))
        .toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(checkInstagramMedia(target(1), { type: 'image', url: 'https://x.test/a.png?sig=1' }, { sender: 'staff', now }))
      .toEqual({ humanAgentTag: false });
  });
});

describe('loadInstagramTarget', () => {
  const ACCOUNT = '11111111-1111-4111-8111-111111111111';
  const CONV = '33333333-3333-4333-8333-333333333333';
  const row = (accessTokenEnc: string) => ({
    channel: 'instagram', contact_id: 'k', instagram_account_id: 'i', ig_user_id: '111', status: 'connected',
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], access_token_enc: accessTokenEnc,
    igsid: '222', blocked_at: null, last_customer_at: now,
  });
  const tx = (accessTokenEnc: string) => ({ $queryRaw: vi.fn(async () => [row(accessTokenEnc)]) }) as never;

  it('refuses a token that cannot be decrypted as token_invalid, before any intent', async () => {
    await expect(loadInstagramTarget(tx('not-a-ciphertext'), ACCOUNT, CONV)).rejects.toMatchObject({ code: 'instagram_token_invalid' });
  });

  it('loads a target whose token decrypts, without returning the plaintext', async () => {
    const enc = encrypt('test-only-ig-token');
    const loaded = await loadInstagramTarget(tx(enc), ACCOUNT, CONV);
    expect(loaded).toMatchObject({ igUserId: '111', igsid: '222', accessTokenEnc: enc });
    expect(JSON.stringify(loaded)).not.toContain('test-only-ig-token');
  });
});

describe('storeInstagramSentMessage', () => {
  it('replaces only an external echo row with the same mid, in one statement', async () => {
    const queryRaw = vi.fn(async () => [{ id: 'row-1' }]);
    const id = await storeInstagramSentMessage({ $queryRaw: queryRaw } as never, {
      accountId: 'a', conversationId: 'c', senderType: 'bot', senderId: null, contentType: 'text', contentText: 'hi', messageId: 'mid.1',
    });
    expect(id).toBe('row-1');
    const sql = (queryRaw.mock.calls[0] as unknown as [{ strings: string[] }])[0].strings.join('?');
    expect(sql).toContain('ON CONFLICT(conversation_id,message_id) DO UPDATE');
    expect(sql).toContain("messages.sender_type='agent' AND messages.sender_id IS NULL");
    expect(sql).toContain("messages.interactive_payload->'ig'->>'external_echo'='true'");
  });

  it('returns null when another row already holds the mid', async () => {
    const id = await storeInstagramSentMessage({ $queryRaw: vi.fn(async () => []) } as never, {
      accountId: 'a', conversationId: 'c', senderType: 'agent', senderId: 'u', contentType: 'text', contentText: 'hi', messageId: 'mid.1',
    });
    expect(id).toBeNull();
  });
});
