import { describe, expect, it } from 'vitest';
import { processedWebhookShell } from './webhook-shell';

const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
        contacts: [{ profile: { name: 'Priya Sharma' }, wa_id: '919812345678' }],
        messages: [
          { from: '919812345678', id: 'wamid.TEXT', timestamp: '1732000000', type: 'text', text: { body: 'my address is 12 MG Road' } },
          { from: '919812345678', id: 'wamid.IMG', timestamp: '1732000001', type: 'image',
            image: { id: 'media-1', caption: 'my card', url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' } },
        ],
        statuses: [{ id: 'wamid.OUT', status: 'read', timestamp: '1732000002', recipient_id: '919812345678' }],
        errors: [{ code: 131026, title: 'Message undeliverable', message: 'details', error_data: { details: 'text' } }],
      },
    }],
  }],
};

describe('processedWebhookShell', () => {
  it('keeps ids and types only', () => {
    expect(processedWebhookShell(payload)).toEqual({
      object: 'whatsapp_business_account',
      stripped: true,
      entry: [{
        id: '102290129340398',
        changes: [{
          field: 'messages',
          phone_number_id: '106540352242922',
          messages: [{ id: 'wamid.TEXT', type: 'text', timestamp: '1732000000' }, { id: 'wamid.IMG', type: 'image', timestamp: '1732000001' }],
          statuses: [{ id: 'wamid.OUT', status: 'read', timestamp: '1732000002' }],
          errors: [{ code: 131026 }],
        }],
      }],
    });
  });

  it('drops message text, captions, media links, names and phone numbers', () => {
    const stored = JSON.stringify(processedWebhookShell(payload));
    for (const secret of ['12 MG Road', 'my card', 'lookaside', 'Priya', '919812345678', '15550783881', 'media-1', 'undeliverable'])
      expect(stored).not.toContain(secret);
  });

  it('survives malformed bodies', () => {
    expect(processedWebhookShell(null)).toEqual({ object: undefined, stripped: true, entry: [] });
    expect(processedWebhookShell({ entry: [null, { changes: 'x' }] })).toEqual({
      object: undefined, stripped: true, entry: [{ id: undefined, changes: [] }, { id: undefined, changes: [] }],
    });
  });
});
