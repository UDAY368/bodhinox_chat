import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it } from 'vitest';
import { instagramReceipt, MessageBubble } from './message-bubble';
import type { Message, MessageTemplate } from '@/types';
const message: Message = {
  id: 'm',
  conversation_id: 'c',
  sender_type: 'agent',
  content_type: 'template',
  template_name: 'order',
  content_text: 'Order 10 ready',
  media_url: 'https://example.com/sent.jpg',
  status: 'sent',
  created_at: '2026-01-01T12:00:00Z',
};
const template: MessageTemplate = {
  id: 't',
  user_id: 'u',
  name: 'order',
  category: 'Utility',
  body_text: 'Order {{1}} ready',
  footer_text: 'Thank you',
  buttons: [{ type: 'URL', text: 'Track order', url: 'javascript:alert(1)' }],
  header_type: 'text',
  header_content: 'Your order',
  created_at: message.created_at,
};
const render = (value: MessageTemplate) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ Inbox: { bubble: { template: 'Template', photo: 'Photo' } } }}
    >
      <MessageBubble message={message} template={value} />
    </NextIntlClientProvider>
  );
it('renders template header, saved body, footer and buttons without activating template links', () => {
  const html = render(template);
  for (const text of [
    'Your order',
    'Order 10 ready',
    'Thank you',
    'Track order',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('javascript:');
});
it('uses the actual sent media URL for a template header', () => {
  expect(
    render({
      ...template,
      header_type: 'image',
      header_media_url: 'https://example.com/old.jpg',
    })
  ).toContain('https://example.com/sent.jpg');
});

// Instagram chats use Instagram's own look: round bubbles, no ticks, and
// Sent / Seen only under the newest message the business sent.
const igText: Message = { ...message, content_type: 'text', template_name: undefined, media_url: undefined, content_text: 'See you there' };
const igRender = (props: Partial<React.ComponentProps<typeof MessageBubble>>) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ Inbox: { bubble: { igReceipt: { sending: 'Sending…', sent: 'Sent', seen: 'Seen' } }, channel: { deliveryUncertain: 'Uncertain' } } }}
    >
      <MessageBubble message={igText} channel="instagram" {...props} />
    </NextIntlClientProvider>
  );

it('maps delivery states to Instagram words: sending, sent (also delivered), seen; nothing for failed or unknown', () => {
  expect(instagramReceipt('sending')).toBe('sending');
  expect(instagramReceipt('sent')).toBe('sent');
  expect(instagramReceipt('delivered')).toBe('sent');
  expect(instagramReceipt('read')).toBe('seen');
  expect(instagramReceipt('failed')).toBeNull();
  expect(instagramReceipt('unknown')).toBeNull();
});

it('draws an Instagram bubble without ticks, and shows Seen only on the newest sent message', () => {
  const newest = igRender({ message: { ...igText, status: 'read' }, receipt: true });
  expect(newest).toContain('ig-message-outgoing');
  expect(newest).toContain('data-receipt="seen"');
  expect(newest).toContain('Seen');
  expect(newest).not.toContain('studio-message');
  const older = igRender({ message: { ...igText, status: 'read' }, receipt: false });
  expect(older).not.toContain('data-receipt');
  const incoming = igRender({ message: { ...igText, sender_type: 'customer' }, receipt: true });
  expect(incoming).toContain('ig-message-incoming');
  expect(incoming).not.toContain('data-receipt');
});

it('keeps the WhatsApp bubble for WhatsApp chats', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ Inbox: { bubble: {}, channel: {} } }}>
      <MessageBubble message={igText} />
    </NextIntlClientProvider>
  );
  expect(html).toContain('studio-message-outgoing');
  expect(html).not.toContain('ig-message');
});
