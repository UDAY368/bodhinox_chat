import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContext } from '@/lib/db/tenant';
const scope = new AsyncLocalStorage<TenantContext>();
export function currentJobScope() { return scope.getStore(); }
export function withJobScope<T>(context: TenantContext, work: () => T): T { return scope.run(context, work); }
