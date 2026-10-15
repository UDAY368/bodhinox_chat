import { describe, expect, it } from 'vitest'
import { validateCollectedInput } from './input-validation'
describe('flow input validation', () => {
  it('refuses invalid email and phone without discarding valid input', async () => {
    expect(await validateCollectedInput('broken', { validation: 'email' })).toBe(false)
    expect(await validateCollectedInput('person@example.com', { validation: 'email' })).toBe(true)
    expect(await validateCollectedInput('+919876543210', { validation: 'phone' })).toBe(true)
    expect(await validateCollectedInput('call me tomorrow', { validation: 'phone' })).toBe(false)
  })
  it('checks the complete input and rejects malformed patterns', async () => {
    expect(await validateCollectedInput('1234', { validation: 'regex', regex: '[0-9]{4}' })).toBe(true)
    expect(await validateCollectedInput('x1234x', { validation: 'regex', regex: '[0-9]{4}' })).toBe(false)
    expect(await validateCollectedInput('anything', { validation: 'regex', regex: '[' })).toBe(false)
  })
  it('bounds pathological regular expression execution', async () => {
    expect(await validateCollectedInput('a'.repeat(2000) + '!', { validation: 'regex', regex: '(a+)+' })).toBe(false)
  })
})
