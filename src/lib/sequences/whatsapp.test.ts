import { describe, expect, it } from 'vitest';
import {
  chooseWhatsAppSend,
  exitApplies,
  exitReason,
  fillTemplateParams,
  parseExitPatch,
  parseWhatsAppStep,
} from './whatsapp';

const TAG = '11111111-1111-4111-8111-111111111111';
const template = { name: 'welcome_back', language: 'en', params: ['{{contact.name|there}}'] };

describe('WhatsApp step: window and template choice', () => {
  it('sends the message inside the window and the template outside it', () => {
    const step = { text: 'Hi', media: null, template };
    expect(chooseWhatsAppSend(step, true)).toEqual({ kind: 'message' });
    expect(chooseWhatsAppSend(step, false)).toEqual({ kind: 'template' });
  });

  it('skips a step with no template outside the window, never sending free text late', () => {
    expect(chooseWhatsAppSend({ text: 'Hi', media: null, template: null }, false))
      .toEqual({ kind: 'skip', reason: 'outside_window_no_template' });
    expect(chooseWhatsAppSend({ text: null, media: { type: 'image', url: 'https://x.test/a.png', filename: null }, template: null }, false))
      .toEqual({ kind: 'skip', reason: 'outside_window_no_template' });
  });

  it('uses the template inside the window only when the step has no content of its own', () => {
    expect(chooseWhatsAppSend({ text: null, media: null, template }, true)).toEqual({ kind: 'template' });
    expect(chooseWhatsAppSend({ text: null, media: null, template: null }, true)).toEqual({ kind: 'skip', reason: 'no_content' });
  });

  it('fills template values from the contact, pads to the template and never sends an empty value', () => {
    const contact = { fields: { name: 'Asha', company: null } };
    expect(fillTemplateParams(['{{contact.name|there}}', '{{contact.company}}'], 3, contact)).toEqual(['Asha', '-', '-']);
    expect(fillTemplateParams(['{{contact.name|there}}'], 1, {})).toEqual(['there']);
    expect(fillTemplateParams(['a', 'b'], 1, {})).toEqual(['a']);
    // A value that looks like a placeholder is not expanded again.
    expect(fillTemplateParams(['{{contact.name}}'], 1, { fields: { name: '{{contact.email}}' } })).toEqual(['{{contact.email}}']);
  });
});

describe('parseWhatsAppStep', () => {
  it('accepts text, media and a template', () => {
    expect(parseWhatsAppStep({ text: ' Hi ', template: { name: 'promo', params: ['x'] } }))
      .toEqual({ text: 'Hi', media: null, template: { name: 'promo', language: null, params: ['x'] } });
    expect(parseWhatsAppStep({ media: { type: 'document', url: '/api/media/object?bucket=b&key=k', filename: 'a.pdf' } }))
      .toMatchObject({ media: { type: 'document', filename: 'a.pdf' } });
  });

  it('refuses an empty step, unknown keys, non-https media, long captions and too many values', () => {
    for (const bad of [
      {}, { text: '  ' }, { text: 'x', extra: 1 }, { media: { type: 'image', url: 'http://x.test/a.png' } },
      { media: { type: 'sticker', url: 'https://x.test/a' } },
      { text: 'x'.repeat(1025), media: { type: 'image', url: 'https://x.test/a.png' } }, { text: 'x'.repeat(4097) },
      { text: 'x', template: { name: '' } }, { text: 'x', template: { name: 'a', params: Array(21).fill('v') } },
      { text: 'x', template: { name: 'a', params: [1] } }, null, 'text',
    ]) expect(parseWhatsAppStep(bad)).toBeNull();
  });
});

describe('Exit when', () => {
  it('stops on the first rule that applies', () => {
    expect(exitReason({ replied: false, tagged: false, purchased: false })).toBeNull();
    expect(exitReason({ replied: true, tagged: true, purchased: true })).toBe('replied');
    expect(exitReason({ replied: false, tagged: true, purchased: true })).toBe('tagged');
    expect(exitReason({ replied: false, tagged: false, purchased: true })).toBe('purchased');
  });

  it('applies a pushed event only to sequences with the matching setting', () => {
    const settings = { exit_on_reply: true, exit_on_tag_id: TAG, exit_on_purchase: false };
    expect(exitApplies(settings, 'replied')).toBe(true);
    expect(exitApplies(settings, 'purchased')).toBe(false);
    expect(exitApplies(settings, 'tagged', TAG.toUpperCase())).toBe(true);
    expect(exitApplies(settings, 'tagged', '22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(exitApplies({ ...settings, exit_on_tag_id: null }, 'tagged', TAG)).toBe(false);
  });

  it('validates the settings in a PATCH body', () => {
    expect(parseExitPatch({ exit_on_reply: true, exit_on_tag_id: TAG })).toEqual({ exit_on_reply: true, exit_on_tag_id: TAG });
    expect(parseExitPatch({ exit_on_tag_id: null })).toEqual({ exit_on_tag_id: null });
    expect(parseExitPatch({ exit_on_reply: 'yes' })).toBeNull();
    expect(parseExitPatch({ exit_on_tag_id: 'not-a-uuid' })).toBeNull();
  });
});
