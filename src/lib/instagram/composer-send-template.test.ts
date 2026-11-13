// The inbox sending a saved Instagram card / button template (ig_template):
// the template is read inside the send's tenant transaction for this workspace
// only, checked against the window and limits before anything is stored, stored
// as an interactive row naming the template, and dispatched once by row id; an
// ambiguous outcome leaves the row 'unknown' for a person to check.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  dispatch: vi.fn(),
  load: vi.fn(),
  read: vi.fn(),
  checkCards: vi.fn(),
  checkButtons: vi.fn(),
  sendCards: vi.fn(),
  sendButtons: vi.fn(),
}));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn() }));
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
    checkInstagramCards: h.checkCards,
    checkInstagramButtonTemplate: h.checkButtons,
    sendInstagramCards: h.sendCards,
    sendInstagramButtonTemplate: h.sendButtons,
  };
});
vi.mock('./message-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./message-templates')>();
  return { ...actual, readInstagramTemplate: h.read };
});

import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { InstagramDeliveryUncertainError, sendInstagramFromComposer } from './composer-send';
import { InstagramError } from './errors';
import { InstagramTemplateError } from './message-templates';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const TEMPLATE = '55555555-5555-4555-8555-555555555555';
const TARGET = { accountId: ACCOUNT, conversationId: CONV, contactId: 'c', instagramAccountId: 'ia', igUserId: '1', igsid: '2',
  accessTokenEnc: 'enc', scopes: [], lastCustomerAt: new Date() };
const CARDS = [{ title: 'Linen shirt', imageUrl: 'https://cdn.example.com/a.jpg', buttons: [{ type: 'web_url', title: 'Buy', url: 'https://shop.example.com' }] }];
const send = () => sendInstagramFromComposer({ accountId: ACCOUNT, userId: USER, conversationId: CONV, messageType: 'ig_template',
  contentText: undefined, mediaUrl: undefined, templateId: TEMPLATE });
const insertCall = () => h.queryRaw.mock.calls.find((call) => (call[0] as TemplateStringsArray).join('?').includes('INSERT INTO messages'));
const sqlOf = (mock: typeof h.executeRaw) => mock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  h.checkCards.mockReset();
  h.checkButtons.mockReset();
  h.load.mockResolvedValue(TARGET);
  h.queryRaw.mockResolvedValue([{ id: ROW }]);
  h.executeRaw.mockResolvedValue(1);
  h.dispatch.mockImplementation(async (_a: string, _k: string, deliver: () => Promise<unknown>) => deliver());
  h.sendCards.mockResolvedValue({ messageId: 'mid-cards' });
  h.sendButtons.mockResolvedValue({ messageId: 'mid-buttons' });
  h.read.mockResolvedValue({ id: TEMPLATE, name: 'Spring sale', kind: 'cards', payload: { cards: CARDS }, updated_at: '' });
});

describe('sending a saved Instagram template', () => {
  it('reads it for this workspace, checks it, stores an interactive row and sends the cards once', async () => {
    expect(await send()).toEqual({ messageId: ROW, providerMessageId: 'mid-cards' });
    expect(h.read).toHaveBeenCalledWith(expect.anything(), ACCOUNT, TEMPLATE);
    expect(h.checkCards).toHaveBeenCalledWith(TARGET, CARDS, expect.objectContaining({ sender: 'staff' }));
    const values = insertCall()!.slice(1);
    expect(values).toContain('interactive');
    const payload = JSON.parse(values.find((v) => typeof v === 'string' && v.startsWith('{')) as string);
    expect(payload).toMatchObject({ kind: 'cards', ig: { generic_template: true, template_id: TEMPLATE, template_name: 'Spring sale' } });
    expect(h.dispatch).toHaveBeenCalledWith(ACCOUNT, `ig_send:${ROW}`, expect.any(Function));
    expect(h.sendCards).toHaveBeenCalledWith(TARGET, CARDS, expect.anything());
    expect(sqlOf(h.executeRaw).some((s) => s.includes("SET status='sent'"))).toBe(true);
  });

  it('sends a button template as one', async () => {
    const buttons = [{ type: 'postback', title: 'Today', payload: 'reply:Today' }];
    h.read.mockResolvedValue({ id: TEMPLATE, name: 'Book', kind: 'button', payload: { text: 'Pick a time', buttons }, updated_at: '' });
    expect((await send()).providerMessageId).toBe('mid-buttons');
    expect(h.checkButtons).toHaveBeenCalledWith(TARGET, 'Pick a time', buttons, expect.anything());
    expect(h.sendButtons).toHaveBeenCalledWith(TARGET, 'Pick a time', buttons, expect.anything());
  });

  it("refuses another workspace's or a missing template before anything is stored", async () => {
    h.read.mockRejectedValue(new InstagramTemplateError('not_found'));
    await expect(send()).rejects.toBeInstanceOf(InstagramError);
    expect(insertCall()).toBeUndefined();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('refuses outside the messaging window before anything is stored', async () => {
    h.checkCards.mockImplementation(() => { throw new InstagramError('instagram_window_closed'); });
    await expect(send()).rejects.toBeInstanceOf(InstagramError);
    expect(insertCall()).toBeUndefined();
    expect(h.sendCards).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous send as unknown, never failed', async () => {
    h.dispatch.mockRejectedValue(new UncertainDispatchError());
    await expect(send()).rejects.toBeInstanceOf(InstagramDeliveryUncertainError);
    expect(sqlOf(h.executeRaw).some((s) => s.includes('UPDATE messages SET status='))).toBe(true);
    expect(h.executeRaw.mock.calls.some((c) => c.includes('unknown'))).toBe(true);
  });
});
