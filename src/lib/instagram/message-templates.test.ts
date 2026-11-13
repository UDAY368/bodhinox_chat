import { describe, expect, it } from 'vitest';
import { decodePostback } from './postback-payloads';
import { InstagramTemplateError, parseTemplateInput, replyPayload, templatePreview } from './message-templates';

const fails = (body: unknown) => expect(() => parseTemplateInput(body)).toThrow(InstagramTemplateError);

describe('parseTemplateInput', () => {
  it('accepts a card gallery and trims its text', () => {
    const parsed = parseTemplateInput({
      name: '  Spring sale ',
      kind: 'cards',
      payload: { cards: [{ title: ' Linen shirt ', subtitle: 'Rs 1,499', imageUrl: 'https://cdn.example.com/a.jpg',
        buttons: [{ type: 'web_url', title: 'Buy', url: 'https://shop.example.com/a' }, { type: 'reply', title: 'Sizes?' }] }] },
    });
    expect(parsed.name).toBe('Spring sale');
    expect(parsed.payload).toEqual({ cards: [{ title: 'Linen shirt', subtitle: 'Rs 1,499', imageUrl: 'https://cdn.example.com/a.jpg',
      buttons: [{ type: 'web_url', title: 'Buy', url: 'https://shop.example.com/a' }, { type: 'postback', title: 'Sizes?', payload: 'reply:Sizes?' }] }] });
  });

  it('accepts a button message', () => {
    const parsed = parseTemplateInput({ name: 'Book', kind: 'button', payload: { text: 'Pick a time', buttons: [{ type: 'reply', title: 'Today' }] } });
    expect(templatePreview(parsed)).toBe('Pick a time');
  });

  it('refuses what Instagram would refuse', () => {
    fails({ name: '', kind: 'button', payload: { text: 'x', buttons: [{ type: 'reply', title: 'a' }] } });
    fails({ name: 'n'.repeat(81), kind: 'button', payload: { text: 'x', buttons: [{ type: 'reply', title: 'a' }] } });
    fails({ name: 'No buttons', kind: 'button', payload: { text: 'x', buttons: [] } });
    fails({ name: 'Four', kind: 'button', payload: { text: 'x', buttons: Array(4).fill({ type: 'reply', title: 'a' }) } });
    fails({ name: 'Long title', kind: 'button', payload: { text: 'x', buttons: [{ type: 'reply', title: 'x'.repeat(21) }] } });
    fails({ name: 'Http', kind: 'button', payload: { text: 'x', buttons: [{ type: 'web_url', title: 'a', url: 'http://plain.example.com' }] } });
    fails({ name: 'Js', kind: 'button', payload: { text: 'x', buttons: [{ type: 'web_url', title: 'a', url: 'javascript:alert(1)' }] } });
    fails({ name: 'No cards', kind: 'cards', payload: { cards: [] } });
    fails({ name: 'Eleven', kind: 'cards', payload: { cards: Array(11).fill({ title: 'a' }) } });
    fails({ name: 'Bad image', kind: 'cards', payload: { cards: [{ title: 'a', imageUrl: 'ftp://x' }] } });
    fails({ name: 'Kind', kind: 'carousel', payload: { cards: [{ title: 'a' }] } });
  });

  it('makes reply payloads itself, so a member cannot send a flow code', () => {
    const parsed = parseTemplateInput({ name: 'Sneaky', kind: 'button',
      payload: { text: 'x', buttons: [{ type: 'postback', title: 'Go', payload: 'menu:3f2b6c1e-8a4d-4b7e-9c2a-1d5e6f7a8b9c' }] } });
    const button = (parsed.payload as { buttons: { payload?: string }[] }).buttons[0];
    expect(button.payload).toBe('reply:Go');
    expect(decodePostback(replyPayload('ib:anything'))).toBeNull();
  });
});

describe('the stored size cap', () => {
  it('refuses a template whose links make it too large to store', () => {
    const long = `https://cdn.example.com/${'x'.repeat(1900)}`;
    const card = { title: 'a', imageUrl: long, defaultUrl: long, buttons: [{ type: 'web_url', title: 'b', url: long }] };
    expect(() => parseTemplateInput({ name: 'Big', kind: 'cards', payload: { cards: Array(10).fill(card) } }))
      .toThrow(expect.objectContaining({ code: 'too_large' }));
  });

  it('counts an emoji as one character, as Instagram does', () => {
    expect(() => parseTemplateInput({ name: 'Emoji', kind: 'button', payload: { text: 'x', buttons: [{ type: 'reply', title: '🎉'.repeat(20) }] } })).not.toThrow();
  });
});
