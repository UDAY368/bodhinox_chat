import { expect, it, vi } from 'vitest'

vi.mock('./meta-api', () => { throw new Error('Provider transport must remain on the server') })

it('validates interactive messages without loading the server provider transport', async () => {
  const { validateInteractivePayload } = await import('./interactive')
  expect(validateInteractivePayload({ kind: 'buttons', body: 'Hello', buttons: [{ id: 'one', title: 'Yes' }] }).ok).toBe(true)
})
