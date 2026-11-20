import { AsyncLocalStorage } from 'node:async_hooks'
const guards = new AsyncLocalStorage<{ guard: () => void; jobId?: string }>()
export function withLeaseScope<T>(guard: () => void, work: () => T, jobId?: string): T { return guards.run({ guard, jobId }, work) }
export function assertJobLease() { guards.getStore()?.guard() }
/** The id of the job this code runs in, or undefined outside a worker job. */
export function currentJobId(): string | undefined { return guards.getStore()?.jobId }
export function leaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  assertJobLease()
  return globalThis.fetch(input, init)
}
