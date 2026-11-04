// Side-effect guard for flow dry runs (Phase 12, design §6.1).
//
// Code running inside withDryRun() cannot change anything: every withTenant
// transaction (on any Prisma client, the worker client included) starts with
// SET TRANSACTION READ ONLY, so a database write raises SQLSTATE 25006; and
// enqueueJob, dispatchOnce and safeFetch call assertLiveEffects() first, so a
// job, a customer send (every send claims an outbound intent through
// dispatchOnce before any provider call) or an outbound HTTP request throws
// DryRunSideEffectError before doing anything. The scope follows the async
// call chain (AsyncLocalStorage), so work started outside it is unaffected.
import { AsyncLocalStorage } from 'node:async_hooks';

export type SideEffectKind = 'job' | 'dispatch' | 'fetch';

export class DryRunSideEffectError extends Error {
  constructor(public readonly kind: SideEffectKind) {
    super(`A dry run cannot perform a side effect (${kind})`);
    this.name = 'DryRunSideEffectError';
  }
}

const scope = new AsyncLocalStorage<{ dryRun: true }>();

/** Runs `fn` with every database write, job, send and outbound request refused. */
export function withDryRun<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ dryRun: true }, fn);
}

export function isDryRun(): boolean {
  return scope.getStore()?.dryRun === true;
}

/** Throws inside a dry run; a no-op otherwise. Call it before the side effect starts. */
export function assertLiveEffects(kind: SideEffectKind): void {
  if (isDryRun()) throw new DryRunSideEffectError(kind);
}
