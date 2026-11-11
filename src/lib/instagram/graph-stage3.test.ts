// Stage 3A graph client: the live_comments webhook field, the persistent menu
// (messenger_profile) and the live comment read for the AI approval queue.
// live_comments and persistent_menu on an Instagram Login app are built
// against Meta's documented shapes (fixtures below) and need a live capture
// before their features ship; they stay behind INSTAGRAM_ENABLED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_LIMITS,
  InstagramGraphInputError,
  getComment,
  setPersistentMenu,
  subscribe,
  type PersistentMenuItem,
} from './graph';
import { persistentMenuFits } from './graph-limits';

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));

const TOKEN = 'IGAA-test-only-token';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const call = (index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
};
const FLOW = '3f1c2a4e-9b7d-4c1a-8e2f-0a1b2c3d4e5f';
const postback = (title: string): PersistentMenuItem => ({ type: 'postback', title, payload: `menu:${FLOW}` });
const link = (title: string, url = 'https://shop.example.test/a'): PersistentMenuItem => ({ type: 'web_url', title, url });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('live_comments subscription', () => {
  it('subscribes the live_comments field with the others, token in the header only', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await subscribe('111', TOKEN, ['messages', 'messaging_postbacks', 'comments', 'live_comments']);
    const sent = call(0);
    expect(sent.init.method).toBe('POST');
    expect(sent.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/111/subscribed_apps`);
    expect(sent.url.searchParams.get('subscribed_fields')).toBe('messages,messaging_postbacks,comments,live_comments');
    expect(sent.url.toString()).not.toContain(TOKEN);
    expect(sent.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('persistent menu', () => {
  it('limits: at most 20 items, titles at most 30 characters, distinct, https links', () => {
    expect(INSTAGRAM_LIMITS.persistentMenuItems).toBe(20);
    const many = (n: number) => Array.from({ length: n }, (_, i) => postback(`Item ${i}`));
    expect(persistentMenuFits([])).toBe(true);
    expect(persistentMenuFits(many(20))).toBe(true);
    expect(persistentMenuFits(many(21))).toBe(false);
    expect(persistentMenuFits([postback('x'.repeat(30))])).toBe(true);
    expect(persistentMenuFits([postback('x'.repeat(31))])).toBe(false);
    expect(persistentMenuFits([postback('Shop'), link(' shop ')])).toBe(false);
    expect(persistentMenuFits([link('Shop', 'http://insecure.example.test')])).toBe(false);
    expect(persistentMenuFits([postback(' ')])).toBe(false);
    expect(persistentMenuFits([{ type: 'postback', title: 'Big', payload: 'x'.repeat(1001) }])).toBe(false);
    expect(persistentMenuFits([{ type: 'phone_number', title: 'Call', payload: '+1' } as unknown as PersistentMenuItem])).toBe(false);
  });

  it('posts the documented messenger_profile shape and deletes the menu for an empty list', async () => {
    fetchMock.mockImplementation(async () => json({ result: 'success' }));
    await setPersistentMenu('111', TOKEN, [postback(' Book a call '), link('Shop')]);
    const set = call(0);
    expect(set.init.method).toBe('POST');
    expect(set.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/111/messenger_profile`);
    expect(set.url.search).toBe('');
    expect(set.body).toEqual({
      platform: 'instagram',
      persistent_menu: [{
        locale: 'default',
        call_to_actions: [
          { type: 'postback', title: 'Book a call', payload: `menu:${FLOW}` },
          { type: 'web_url', title: 'Shop', url: 'https://shop.example.test/a', webview_height_ratio: 'full' },
        ],
      }],
    });
    await setPersistentMenu('111', TOKEN, []);
    const clear = call(1);
    expect(clear.init.method).toBe('DELETE');
    expect(clear.body).toEqual({ platform: 'instagram', fields: ['persistent_menu'] });
  });

  it('refuses a menu that does not fit or a bad account id before any request; a non-success result is ambiguous', async () => {
    await expect(setPersistentMenu('111', TOKEN, Array.from({ length: 21 }, (_, i) => postback(`I${i}`))))
      .rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(setPersistentMenu('../me', TOKEN, [postback('A')])).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({}));
    expect((await setPersistentMenu('111', TOKEN, [postback('A')]).catch((e: unknown) => e) as MetaApiError).httpStatus).toBe(502);
  });

  it('keeps Meta’s error text out of the thrown error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'secret detail about the account', code: 100, fbtrace_id: 'trace' } }, 400));
    const error = await setPersistentMenu('111', TOKEN, [postback('A')]).catch((e: unknown) => e) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe('Meta API error: 400');
    expect(JSON.stringify(error)).not.toContain('secret detail');
  });
});

describe('getComment (AI approval queue)', () => {
  it('reads the comment with checked fields only', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '{"id":17890000000000001,"text":"Love this!","hidden":false,"timestamp":"2026-11-10T10:00:00+0000","username":"fan","media":{"id":"17900000000000002"},"extra":"x"}',
      { status: 200 }));
    const comment = await getComment('17890000000000001', TOKEN);
    expect(comment).toEqual({
      id: '17890000000000001', text: 'Love this!', hidden: false, username: 'fan', mediaId: '17900000000000002',
      timestamp: '2026-11-10T10:00:00.000Z',
    });
    const sent = call(0);
    expect(sent.init.method).toBe('GET');
    expect(sent.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/17890000000000001`);
    expect(sent.url.searchParams.get('fields')).toBe('id,text,hidden,timestamp,username,media');
  });

  it('caps the text, treats missing fields as unknown and a deleted comment as a 4xx', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '17890000000000001', text: 'x'.repeat(5000) }));
    const long = await getComment('17890000000000001', TOKEN);
    expect(long.text).toHaveLength(2200);
    expect(long).toMatchObject({ hidden: null, username: null, mediaId: null, timestamp: null });
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Unsupported get request', code: 100 } }, 400));
    expect((await getComment('17890000000000001', TOKEN).catch((e: unknown) => e) as MetaApiError).httpStatus).toBe(400);
    await expect(getComment('not-an-id', TOKEN)).rejects.toBeInstanceOf(InstagramGraphInputError);
  });
});
