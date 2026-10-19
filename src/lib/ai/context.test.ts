import { describe, it, expect } from 'vitest'
import type { DataClient } from '@/lib/data/types'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): DataClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as DataClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})


it('includes interactive prompt labels and the customer selection without action secrets', async () => {
  const out = await buildConversationContext(fakeDb([
    { sender_type: 'customer', content_type: 'interactive', content_text: 'Pricing', interactive_reply_id: 'private-reply-id' },
    { sender_type: 'bot', content_type: 'interactive', content_text: 'Choose a topic', interactive_payload: {
      kind: 'buttons', header: 'Welcome', body: 'Choose a topic', footer: 'Happy to help',
      media: { url: 'https://private/media' },
      buttons: [{ title: 'Pricing', id: 'private-action-id', action: { targetId: 'private-flow-id' } }],
    } },
  ]), 'conv-1')
  expect(out).toEqual([
    { role: 'assistant', content: 'Welcome\nChoose a topic\nHappy to help\nOptions: Pricing' },
    { role: 'user', content: 'Pricing' },
  ])
  expect(JSON.stringify(out)).not.toContain('private')
})

it('includes list choices and template text in the transcript', async () => {
  const out = await buildConversationContext(fakeDb([
    { sender_type: 'agent', content_type: 'template', content_text: 'Your order is ready.' },
    { sender_type: 'bot', content_type: 'interactive', content_text: null, interactive_payload: {
      kind: 'list', body: 'Choose a service', button_label: 'Services',
      sections: [{ title: 'Support', rows: [{ id: 'secret', title: 'Returns', description: 'Return an item' }] }],
    } },
  ]), 'conv-1')
  expect(out[0].content).toContain('Choose a service')
  expect(out[0].content).toContain('Returns')
  expect(out[0].content).toContain('Return an item')
  expect(out[0].content).not.toContain('secret')
  expect(out[1]).toEqual({ role: 'assistant', content: 'Your order is ready.' })
})

it('bounds individual message text and excludes unsupported media payloads', async () => {
  const out = await buildConversationContext(fakeDb([
    { sender_type: 'customer', content_type: 'text', content_text: 'x'.repeat(20_000) },
    { sender_type: 'customer', content_type: 'image', content_text: null, media_url: 'https://private/media' },
  ]), 'conv-1')
  expect(out).toHaveLength(1)
  expect(out[0].content.length).toBeLessThanOrEqual(4000)
})
