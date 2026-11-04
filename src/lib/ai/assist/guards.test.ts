import { describe, expect, it } from 'vitest'
import { guardCustomerText, urlAllowlist } from './guards'

describe('urlAllowlist', () => {
  it('allows cited source URLs and operator links, never links written inside knowledge text', () => {
    const allow = urlAllowlist({
      citations: [{ chunk_id: 'c', document_id: 'd', source_id: null, title: 'FAQ', source_url: 'https://acme.test/faq' }],
      profile: { website_url: null, instructions: 'Send people to www.acme.test/book', greeting: null },
    })
    const out = guardCustomerText('See https://acme.test/faq, www.acme.test/book and https://third-party.example/promo', { allow, healthWorkspace: false })
    expect(out).toMatchObject({ ok: true, flags: ['url_stripped'] })
    if (!out.ok) throw new Error('expected ok')
    expect(out.text).toContain('https://acme.test/faq')
    expect(out.text).toContain('www.acme.test/book')
    expect(out.text).not.toContain('third-party')
  })
})
