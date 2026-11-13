import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  dispatch: vi.fn(),
  load: vi.fn(),
  checkText: vi.fn(),
  checkMedia: vi.fn(),
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  providerUrl: vi.fn(),
}));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: h.providerUrl }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
}));
vi.mock('@/lib/jobs/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/dispatch')>();
  return { ...actual, dispatchOnce: h.dispatch };
});
vi.mock('@/lib/channels/sender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/sender')>();
  return {
    ...actual,
    loadInstagramTarget: h.load,
    checkInstagramText: h.checkText,
    checkInstagramMedia: h.checkMedia,
    sendInstagramText: h.sendText,
    sendInstagramMedia: h.sendMedia,
  };
});

import { ChannelUnavailableError } from '@/lib/channels/sender';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import {
  InstagramDeliveryUncertainError,
  InstagramSendRejectedError,
  sendInstagramFromComposer,
} from './composer-send';
import { InstagramError } from './errors';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const TARGET = { accountId: ACCOUNT, conversationId: CONV, contactId: 'c', instagramAccountId: 'ia', igUserId: '1', igsid: '2',
  accessTokenEnc: 'enc', scopes: [], lastCustomerAt: new Date() };
const input = (extra: Record<string, unknown>) =>
  ({ accountId: ACCOUNT, userId: USER, conversationId: CONV, messageType: 'text', contentText: 'hello', mediaUrl: undefined, ...extra });
const sqlOf = (mock: typeof h.executeRaw) => mock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue(TARGET);
  h.queryRaw.mockResolvedValue([{ id: ROW }]);
  h.executeRaw.mockResolvedValue(1);
  h.dispatch.mockImplementation(async (_a: string, _k: string, send: () => Promise<unknown>) => send());
  h.sendText.mockResolvedValue({ messageId: 'mid-1' });
  h.sendMedia.mockResolvedValue({ messageId: 'mid-2' });
  h.providerUrl.mockImplementation(async (_account: string, url: string) => url);
});

/** The INSERT of the outgoing row (the agent-reply pause runs its own queries first, Stage 5). */
const insertCall = () => h.queryRaw.mock.calls.find((call) =>
  (call[0] as TemplateStringsArray).join('?').includes('INSERT INTO messages'))!;

describe('sendInstagramFromComposer', () => {
  it('stores the row as sending, dispatches once by row id, then marks it sent with the mid', async () => {
    const result = await sendInstagramFromComposer(input({}));
    expect(result).toEqual({ messageId: ROW, providerMessageId: 'mid-1' });
    expect(h.checkText).toHaveBeenCalledWith(TARGET, 'hello', expect.objectContaining({ sender: 'staff' }));
    expect(h.dispatch).toHaveBeenCalledWith(ACCOUNT, `ig_send:${ROW}`, expect.any(Function));
    expect((insertCall()[0] as TemplateStringsArray).join('?')).toContain("'sending'");
    // The agent stepping in pauses automated replies first, in the same transaction.
    expect(sqlOf(h.executeRaw).some((s) => s.includes('UPDATE conversations c SET bot_paused=true'))).toBe(true);
    expect(sqlOf(h.executeRaw).some((s) => s.includes("SET status='sent'"))).toBe(true);
  });

  it('quotes a message of this conversation by its mid and stores the reply link', async () => {
    const PARENT = '55555555-5555-4555-8555-555555555555';
    h.queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('SELECT message_id FROM messages') ? [{ message_id: 'aWdfZAG1-parent' }] : [{ id: ROW }]);
    await sendInstagramFromComposer(input({ replyToMessageId: PARENT }));
    expect(h.sendText).toHaveBeenCalledWith(TARGET, 'hello', expect.anything(), { replyToMid: 'aWdfZAG1-parent' });
    expect(insertCall()).toContain(PARENT);
  });

  it('refuses a quoted message outside the conversation, or a malformed id, before anything is sent', async () => {
    h.queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('SELECT message_id FROM messages') ? [] : [{ id: ROW }]);
    await expect(sendInstagramFromComposer(input({ replyToMessageId: '55555555-5555-4555-8555-555555555555' })))
      .rejects.toBeInstanceOf(InstagramError);
    await expect(sendInstagramFromComposer(input({ replyToMessageId: 'not-a-uuid' }))).rejects.toBeInstanceOf(InstagramError);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['template', ChannelUnavailableError],
    ['interactive', ChannelUnavailableError],
    ['location_request', ChannelUnavailableError],
    ['sticker', ChannelUnavailableError],
  ])('refuses a %s message before anything is stored', async (messageType, error) => {
    await expect(sendInstagramFromComposer(input({ messageType }))).rejects.toBeInstanceOf(error);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a non-PDF document and a media caption', async () => {
    await expect(sendInstagramFromComposer(input({ messageType: 'document', mediaUrl: 'https://x/a.docx', filename: 'a.docx' })))
      .rejects.toBeInstanceOf(ChannelUnavailableError);
    await expect(sendInstagramFromComposer(input({ messageType: 'image', mediaUrl: 'https://x/a.jpg', contentText: 'caption' })))
      .rejects.toBeInstanceOf(InstagramError);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('refuses an Ogg/Opus voice note before anything is stored, and sends m4a audio', async () => {
    await expect(sendInstagramFromComposer(input({ messageType: 'audio', mediaUrl: 'https://x/voice-1.ogg', filename: 'voice-1.ogg' })))
      .rejects.toBeInstanceOf(ChannelUnavailableError);
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    await sendInstagramFromComposer(input({ messageType: 'audio', mediaUrl: 'https://x/clip.m4a', contentText: null }));
    expect(h.checkMedia).toHaveBeenCalledWith(TARGET, { type: 'audio', url: 'https://x/clip.m4a' }, expect.anything());
  });

  it('sends a PDF as a file attachment, keeping its name for our own bubble', async () => {
    await sendInstagramFromComposer(input({ messageType: 'document', mediaUrl: 'https://x/u?id=1', filename: 'menu.pdf', contentText: 'menu.pdf' }));
    expect(h.checkMedia).toHaveBeenCalledWith(TARGET, { type: 'file', url: 'https://x/u?id=1' }, expect.anything());
    expect(h.sendMedia).toHaveBeenCalledTimes(1);
  });

  it('a window refusal stores nothing and calls nothing', async () => {
    h.checkText.mockImplementationOnce(() => { throw new InstagramError('instagram_window_closed'); });
    await expect(sendInstagramFromComposer(input({}))).rejects.toMatchObject({ code: 'instagram_window_closed' });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('an ambiguous outcome leaves the row unknown and is reported, never retried', async () => {
    h.dispatch.mockRejectedValue(new UncertainDispatchError());
    await expect(sendInstagramFromComposer(input({}))).rejects.toBeInstanceOf(InstagramDeliveryUncertainError);
    const settle = h.executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('SET status='));
    expect(settle?.slice(1)).toContain('unknown');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a Meta rejection marks the row failed', async () => {
    h.dispatch.mockRejectedValue(new MetaApiError('rejected', { httpStatus: 400 }));
    await expect(sendInstagramFromComposer(input({}))).rejects.toBeInstanceOf(InstagramSendRejectedError);
    const settle = h.executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('SET status='));
    expect(settle?.slice(1)).toContain('failed');
  });

  it('refuses malformed ids', async () => {
    await expect(sendInstagramFromComposer(input({ conversationId: 'x' }))).rejects.toBeInstanceOf(InstagramError);
  });

  it('sends an app media link to Meta as the signed URL, keeping the app link on the row', async () => {
    const appLink = '/api/media/object?bucket=whatsapp-media&key=account-x%2Fphoto.jpg';
    h.providerUrl.mockResolvedValueOnce('https://s3.example.test/signed/photo.jpg?X-Amz-Signature=abc');
    const result = await sendInstagramFromComposer(input({ messageType: 'image', mediaUrl: appLink, contentText: '' }));
    expect(result.providerMessageId).toBe('mid-2');
    expect(h.providerUrl).toHaveBeenCalledWith(ACCOUNT, appLink);
    const signed = { type: 'image', url: 'https://s3.example.test/signed/photo.jpg?X-Amz-Signature=abc' };
    expect(h.checkMedia).toHaveBeenCalledWith(TARGET, signed, expect.anything());
    expect(h.sendMedia).toHaveBeenCalledWith(TARGET, signed, expect.anything(), { replyToMid: undefined });
    expect(insertCall()).toContain(appLink);
    expect(insertCall()).not.toContain(signed.url);
  });

  it('refuses media outside this workspace before anything is stored', async () => {
    h.providerUrl.mockRejectedValueOnce(new Error('Media belongs to another workspace'));
    await expect(sendInstagramFromComposer(input({ messageType: 'image', mediaUrl: '/api/media/object?bucket=whatsapp-media&key=account-y/a.jpg', contentText: '' })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    h.providerUrl.mockRejectedValueOnce(new Error('Media not found in this workspace'));
    await expect(sendInstagramFromComposer(input({ messageType: 'image', mediaUrl: '/api/media/object?bucket=whatsapp-media&key=account-x/b.jpg', contentText: '' })))
      .rejects.toBeInstanceOf(InstagramError);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a storage fault is not reported as a bad request', async () => {
    h.providerUrl.mockRejectedValueOnce(new Error('S3 credentials missing'));
    await expect(sendInstagramFromComposer(input({ messageType: 'image', mediaUrl: '/api/media/object?bucket=whatsapp-media&key=account-x/a.jpg', contentText: '' })))
      .rejects.not.toBeInstanceOf(InstagramError);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('recognises a PDF app link by its object key', async () => {
    await sendInstagramFromComposer(input({ messageType: 'document', mediaUrl: '/api/media/object?bucket=whatsapp-media&key=account-x%2Fmenu.pdf', contentText: 'menu' }));
    expect(h.sendMedia).toHaveBeenCalledTimes(1);
  });
});
