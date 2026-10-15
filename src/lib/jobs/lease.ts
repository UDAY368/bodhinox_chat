import { AsyncLocalStorage } from 'node:async_hooks'
const guards = new AsyncLocalStorage<() => void>()
export function withLeaseScope<T>(guard: () => void, work: () => T): T { return guards.run(guard, work) }
export function assertJobLease() { guards.getStore()?.() }
export function leaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  assertJobLease()
  return globalThis.fetch(input, init)
}
