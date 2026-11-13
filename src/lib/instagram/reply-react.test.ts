import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramGraphInputError, sendAttachment, sendReaction, sendText, validMessageMid } from './graph';
import { instagramReactionIntent } from './reactions';

const TOKEN = 'IGAA-test-only-token';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sentBody = (index = 0) => JSON.parse((fetchMock.mock.calls[index] as [string, RequestInit])[1].body as string);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Instagram inline replies', () => {
  it('quotes the earlier message with reply_to.mid on text and attachments', async () => {
    fetchMock.mockImplementation(async () => json({ recipient_id: '222', message_id: 'm2' }));
    await sendText('111', TOKEN, '222', 'Sure', { replyToMid: 'aWdfZAG1-mid=' });
    expect(sentBody()).toEqual({ recipient: { id: '222' }, reply_to: { mid: 'aWdfZAG1-mid=' }, message: { text: 'Sure' } });
    await sendAttachment('111', TOKEN, '222', { type: 'image', url: 'https://cdn.example/a.png' }, { replyToMid: 'm1' });
    expect(sentBody(1).reply_to).toEqual({ mid: 'm1' });
  });

  it('sends no reply_to without a target and refuses a malformed mid before calling Meta', async () => {
    fetchMock.mockImplementation(async () => json({ message_id: 'm3' }));
    await sendText('111', TOKEN, '222', 'Hi');
    expect(sentBody()).not.toHaveProperty('reply_to');
    fetchMock.mockClear();
    await expect(sendText('111', TOKEN, '222', 'Hi', { replyToMid: 'bad mid"' })).rejects.toBeInstanceOf(InstagramGraphInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Instagram reactions', () => {
  it('reacts with love and unreacts by message id', async () => {
    fetchMock.mockImplementation(async () => json({ recipient_id: '222' }));
    await sendReaction('111', TOKEN, '222', 'm9', true);
    expect(sentBody()).toEqual({ recipient: { id: '222' }, sender_action: 'react', payload: { message_id: 'm9', reaction: 'love' } });
    await sendReaction('111', TOKEN, '222', 'm9', false);
    expect(sentBody(1)).toEqual({ recipient: { id: '222' }, sender_action: 'unreact', payload: { message_id: 'm9' } });
  });

  it('offers only the heart', () => {
    expect(instagramReactionIntent('❤️')).toBe('react');
    expect(instagramReactionIntent('❤')).toBe('react');
    expect(instagramReactionIntent('')).toBe('unreact');
    expect(instagramReactionIntent('👍')).toBeNull();
  });

  it('validates mids', () => {
    expect(validMessageMid('aWdfZAG1faXRlbToxOklH')).toBe(true);
    expect(validMessageMid('')).toBe(false);
    expect(validMessageMid('a b')).toBe(false);
    expect(validMessageMid(null)).toBe(false);
  });
});
