'use client';

// Client helper for the console pages: every page loads its data from
// /api/platform/*, which checks the platform admin again on each call. When
// the session's MFA confirmation ages out mid-visit, a reload lets the
// layout show the step-up form.

import { authFetch } from '@/lib/auth/client';

export class PlatformApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'PlatformApiError';
  }
}

export async function platformApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await authFetch(path, init?.body === undefined ? { method: init?.method ?? 'GET' } : {
    method: init.method ?? 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof data?.code === 'string' ? data.code : typeof data?.error?.code === 'string' ? data.error.code : 'failed';
    if (response.status === 403 && (code === 'mfa_step_up_required' || code === 'mfa_enrollment_required')) window.location.reload();
    throw new PlatformApiError(response.status, code);
  }
  return data as T;
}

/** The error code of a failed call, for `t(\`errors.${code}\`)` with a generic fallback. */
export function errorCode(error: unknown, known: readonly string[]): string {
  return error instanceof PlatformApiError && known.includes(error.code) ? error.code : 'failed';
}
