'use client';

// Browser view of the workspace plan, for upgrade badges. The server
// enforces every feature and limit; this only explains a disabled control.

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth/client';
import { useAuth } from '@/hooks/use-auth';
import type { Entitlements } from './entitlements';
import type { Feature } from './entitlements-catalogue';

export type PlanView = Entitlements & { usage: Record<string, number> };

// One request per workspace per page load; a failed request is retried on the next mount.
const cache = new Map<string, Promise<PlanView | null>>();
const listeners = new Set<() => void>();

/**
 * Forgets the cached plan and makes every mounted usePlanState read it again,
 * e.g. after an add-on purchase or a cancellation that took effect at once.
 */
export function invalidatePlan(): void {
  cache.clear();
  for (const listener of listeners) listener();
}

export function loadPlan(accountId: string): Promise<PlanView | null> {
  let pending = cache.get(accountId);
  if (!pending) {
    pending = authFetch('/api/account/plan', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<PlanView>) : null))
      .catch(() => null)
      .then((plan) => {
        if (!plan) cache.delete(accountId);
        return plan;
      });
    cache.set(accountId, pending);
  }
  return pending;
}

/** `plan` is undefined while loading and null when it could not be read (controls then stay enabled). */
export function usePlanState(): { plan: PlanView | null | undefined; reload: () => void } {
  const { accountId } = useAuth();
  const [state, setState] = useState<{ accountId: string | null; plan: PlanView | null | undefined }>({ accountId: null, plan: undefined });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const listener = () => setAttempt((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    loadPlan(accountId).then((plan) => live && setState({ accountId, plan }));
    return () => { live = false; };
  }, [accountId, attempt]);
  return {
    // A plan loaded for another workspace is never shown after switching.
    plan: state.accountId === accountId ? state.plan : undefined,
    reload: () => setAttempt((n) => n + 1),
  };
}

export function usePlan(): PlanView | null {
  return usePlanState().plan ?? null;
}

/** False only when the plan is known and lacks the feature. */
export function planAllows(plan: PlanView | null, feature: Feature): boolean {
  return plan === null || plan.features[feature];
}
