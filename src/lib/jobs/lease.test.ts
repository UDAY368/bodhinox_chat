import { expect, it } from 'vitest'
import { assertJobLease, withLeaseScope } from './lease'
it('keeps a lease check across asynchronous work and isolates concurrent jobs', async () => {
  let lost = false
  await withLeaseScope(() => { if (lost) throw new Error('lost') }, async () => {
    await Promise.resolve()
    assertJobLease()
    lost = true
    expect(() => assertJobLease()).toThrow('lost')
    await withLeaseScope(() => {}, async () => { assertJobLease() })
    expect(() => assertJobLease()).toThrow('lost')
  })
  expect(() => assertJobLease()).not.toThrow()
})
