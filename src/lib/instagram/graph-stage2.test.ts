// Stage 2A graph client: payload shapes and documented limits for the comment
// reply, generic template (card and gallery), button template, ice breakers
// and profile follow fields. The ice breaker (messenger_profile) and profile
// follow-field shapes are built against Meta's documented fixtures and still
// need a live capture before their features ship (they stay behind
// INSTAGRAM_ENABLED).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_LIMITS,
  InstagramGraphInputError,
  getProfile,
  replyToComment,
  sendButtonTemplate,
  sendGenericTemplate,
  sendPrivateReply,
  setIceBreakers,
  type IgGenericCard,
} from './graph';
import { buttonTemplateFits, cardFits, genericTemplateFits, iceBreakersFit, quickRepliesFit, validCommentReply } from './graph-limits';

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));

const TOKEN = 'IGAA-test-only-token';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const call = (index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
};
const card = (n: number, extra: Partial<IgGenericCard> = {}): IgGenericCard => ({ title: `Card ${n}`, ...extra });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('documented limits', () => {
  it('quick replies: at most 11, titles at most 20 characters', () => {
    const replies = (n: number, title = 'Yes') => Array.from({ length: n }, (_, i) => ({ title, payload: `p${i}` }));
    expect(INSTAGRAM_LIMITS.quickReplies).toBe(11);
    expect(quickRepliesFit(replies(11))).toBe(true);
    expect(quickRepliesFit(replies(12))).toBe(false);
    expect(quickRepliesFit(replies(1, 'x'.repeat(20)))).toBe(true);
    expect(quickRepliesFit(replies(1, 'x'.repeat(21)))).toBe(false);
    // An emoji counts once, as Meta counts titles.
    expect(quickRepliesFit(replies(1, '👍'.repeat(20)))).toBe(true);
  });

  it('buttons: 1 to 3, https links or postbacks, titles at most 20 characters', () => {
    const url = { type: 'web_url' as const, title: 'Shop', url: 'https://shop.example.test/a' };
    const postback = { type: 'postback' as const, title: 'More', payload: 'more' };
    expect(buttonTemplateFits('Pick', [url, postback, url])).toBe(true);
    expect(buttonTemplateFits('Pick', [url, postback, url, postback])).toBe(false);
    expect(buttonTemplateFits('Pick', [])).toBe(false);
    expect(buttonTemplateFits('Pick', [{ ...url, url: 'http://insecure.example.test' }])).toBe(false);
    expect(buttonTemplateFits('Pick', [{ ...url, title: 'x'.repeat(21) }])).toBe(false);
    expect(buttonTemplateFits('Pick', [{ ...postback, payload: 'x'.repeat(1001) }])).toBe(false);
    expect(buttonTemplateFits('x'.repeat(641), [url])).toBe(false);
  });

  it('generic template: 1 to 10 cards, titles and subtitles at most 80, at most 3 buttons per card', () => {
    expect(genericTemplateFits(Array.from({ length: 10 }, (_, i) => card(i)))).toBe(true);
    expect(genericTemplateFits(Array.from({ length: 11 }, (_, i) => card(i)))).toBe(false);
    expect(genericTemplateFits([])).toBe(false);
    expect(cardFits(card(1, { title: 'x'.repeat(81) }))).toBe(false);
    expect(cardFits(card(1, { subtitle: 'x'.repeat(81) }))).toBe(false);
    expect(cardFits(card(1, { imageUrl: 'ftp://x.test/a.png' }))).toBe(false);
    const button = { type: 'postback' as const, title: 'Go', payload: 'go' };
    expect(cardFits(card(1, { buttons: [button, button, button] }))).toBe(true);
    expect(cardFits(card(1, { buttons: [button, button, button, button] }))).toBe(false);
  });

  it('ice breakers: at most 4 distinct questions; an empty list clears them', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Question ${i}?`, payload: `ib:${i}` }));
    expect(iceBreakersFit(items(4))).toBe(true);
    expect(iceBreakersFit(items(5))).toBe(false);
    expect(iceBreakersFit([])).toBe(true);
    expect(iceBreakersFit([{ question: 'Hours?', payload: 'a' }, { question: ' hours? ', payload: 'b' }])).toBe(false);
    expect(iceBreakersFit([{ question: 'x'.repeat(81), payload: 'a' }])).toBe(false);
  });

  it('comment replies: non-empty, at most 2200 characters', () => {
    expect(validCommentReply('Thanks!')).toBe(true);
    expect(validCommentReply('x'.repeat(2200))).toBe(true);
    expect(validCommentReply('x'.repeat(2201))).toBe(false);
    expect(validCommentReply('  ')).toBe(false);
  });
});

describe('Stage 2 graph payloads', () => {
  it('posts a public comment reply to /{comment-id}/replies with the token in the header', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":17890000000000000001}', { status: 200 }));
    await expect(replyToComment('333', TOKEN, '  Thanks! Check your DMs  ')).resolves.toEqual({ replyId: '17890000000000000001' });
    const { url, body, headers, init } = call();
    expect(init.method).toBe('POST');
    expect(url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/333/replies`);
    expect(url.search).toBe('');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(body).toEqual({ message: 'Thanks! Check your DMs' });
  });

  it('treats a comment reply accepted without an id as ambiguous, and checks input before any request', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    expect((await replyToComment('333', TOKEN, 'Hi').catch((e: unknown) => e) as MetaApiError).httpStatus).toBe(502);
    fetchMock.mockReset();
    await expect(replyToComment('../333', TOKEN, 'Hi')).rejects.toBeInstanceOf(InstagramGraphInputError);
    await expect(replyToComment('333', TOKEN, 'x'.repeat(2201))).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a private reply with the Opening DM quick reply', async () => {
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm1' }));
    await sendPrivateReply('111', TOKEN, '333', 'Here is the link', [{ title: 'Send me the link', payload: 'optin:x' }]);
    expect(call().body).toEqual({
      recipient: { comment_id: '333' },
      message: { text: 'Here is the link', quick_replies: [{ content_type: 'text', title: 'Send me the link', payload: 'optin:x' }] },
    });
    fetchMock.mockReset();
    await expect(sendPrivateReply('111', TOKEN, '333', 'Hi', [])).rejects.toBeInstanceOf(InstagramGraphInputError);
    // The text limit is 1000 UTF-8 bytes, not characters: 334 three-byte characters are 1002 bytes.
    await expect(sendPrivateReply('111', TOKEN, '333', '€'.repeat(334))).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm2' }));
    await sendPrivateReply('111', TOKEN, '333', '€'.repeat(333) + 'x');
    expect(call().body.message.text).toHaveLength(334);
  });

  it('builds a generic template (card or gallery) with image, link and both button kinds', async () => {
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm1', recipient_id: '222' }));
    await sendGenericTemplate('111', TOKEN, '222', [
      card(1, {
        subtitle: 'Only today', imageUrl: 'https://cdn.example.test/a.jpg', defaultUrl: 'https://shop.example.test/a',
        buttons: [{ type: 'web_url', title: 'Buy', url: 'https://shop.example.test/buy' }, { type: 'postback', title: 'More', payload: 'more' }],
      }),
      card(2),
    ]);
    const { url, body } = call();
    expect(url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/111/messages`);
    expect(body).toEqual({
      recipient: { id: '222' },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [
              {
                title: 'Card 1', subtitle: 'Only today', image_url: 'https://cdn.example.test/a.jpg',
                default_action: { type: 'web_url', url: 'https://shop.example.test/a' },
                buttons: [{ type: 'web_url', url: 'https://shop.example.test/buy', title: 'Buy' }, { type: 'postback', title: 'More', payload: 'more' }],
              },
              { title: 'Card 2' },
            ],
          },
        },
      },
    });
    fetchMock.mockReset();
    await expect(sendGenericTemplate('111', TOKEN, '222', Array.from({ length: 11 }, (_, i) => card(i))))
      .rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds a button template with real buttons and the Human Agent tag only when asked', async () => {
    fetchMock.mockResolvedValueOnce(json({ message_id: 'm1' }));
    await sendButtonTemplate('111', TOKEN, '222', 'What next?', [
      { type: 'postback', title: 'Talk to us', payload: 'talk' },
      { type: 'web_url', title: 'Website', url: 'https://shop.example.test' },
    ], { humanAgentTag: true });
    expect(call().body).toEqual({
      recipient: { id: '222' }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT',
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button', text: 'What next?',
            buttons: [{ type: 'postback', title: 'Talk to us', payload: 'talk' }, { type: 'web_url', url: 'https://shop.example.test', title: 'Website' }],
          },
        },
      },
    });
    fetchMock.mockReset();
    const four = Array.from({ length: 4 }, (_, i) => ({ type: 'postback' as const, title: `B${i}`, payload: `b${i}` }));
    await expect(sendButtonTemplate('111', TOKEN, '222', 'Pick', four)).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets ice breakers through messenger_profile (needs live capture) and clears them with an empty list', async () => {
    fetchMock.mockImplementation(async () => json({ result: 'success' }));
    await setIceBreakers('111', TOKEN, [{ question: ' Opening hours? ', payload: 'ib:1' }, { question: 'Prices?', payload: 'ib:2' }]);
    const set = call(0);
    expect(set.init.method).toBe('POST');
    expect(set.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/111/messenger_profile`);
    expect(set.url.search).toBe('');
    expect(set.body).toEqual({
      platform: 'instagram',
      ice_breakers: [{ locale: 'default', call_to_actions: [{ question: 'Opening hours?', payload: 'ib:1' }, { question: 'Prices?', payload: 'ib:2' }] }],
    });
    await setIceBreakers('111', TOKEN, []);
    const clear = call(1);
    expect(clear.init.method).toBe('DELETE');
    expect(clear.body).toEqual({ platform: 'instagram', fields: ['ice_breakers'] });
  });

  it('refuses five ice breakers before any request and treats a non-success result as ambiguous', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, payload: `ib:${i}` }));
    await expect(setIceBreakers('111', TOKEN, five)).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({}));
    expect((await setIceBreakers('111', TOKEN, five.slice(0, 1)).catch((e: unknown) => e) as MetaApiError).httpStatus).toBe(502);
  });

  it('asks for profile follow fields only when asked (needs live capture) and keeps only typed values', async () => {
    fetchMock.mockResolvedValueOnce(json({ name: 'Asha', username: 'asha' }));
    await expect(getProfile('222', TOKEN)).resolves.toEqual({ name: 'Asha', username: 'asha' });
    expect(call(0).url.searchParams.get('fields')).toBe('name,username');

    fetchMock.mockResolvedValueOnce(json({
      name: 'Asha', username: 'asha', is_user_follow_business: true, is_business_follow_user: 'no', is_verified_user: false, follower_count: 1520,
    }));
    await expect(getProfile('222', TOKEN, { facts: true })).resolves.toEqual({
      name: 'Asha', username: 'asha',
      facts: { followsBusiness: true, businessFollows: null, isVerified: false, followerCount: 1520 },
    });
    expect(call(1).url.searchParams.get('fields'))
      .toBe('name,username,is_user_follow_business,is_business_follow_user,is_verified_user,follower_count');
    expect(call(1).url.searchParams.get('access_token')).toBeNull();

    fetchMock.mockResolvedValueOnce(json({ follower_count: -3 }));
    expect((await getProfile('222', TOKEN, { facts: true })).facts?.followerCount).toBeNull();
  });
});
