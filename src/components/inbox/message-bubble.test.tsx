import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it } from 'vitest';
import { MessageBubble } from './message-bubble';
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
