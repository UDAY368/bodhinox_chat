'use client';
// One debounced GET for a search box: waits `delayMs` after the URL last
// changed, cancels the request a newer URL replaces (AbortController), and
// never shows a stale answer: results are kept with the URL they answer.
import { useCallback, useEffect, useState } from 'react';

import { authFetch } from '@/lib/auth/client';

export interface RemoteSearch<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useRemoteSearch<T>(url: string | null, delayMs = 300): RemoteSearch<T> {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; data: T | null; error: boolean } | null>(null);
  const key = url === null ? null : `${attempt}:${url}`;

  useEffect(() => {
    if (url === null || key === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      authFetch(url, { cache: 'no-store', signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`search ${res.status}`);
          const data = (await res.json()) as T;
          setAnswer({ key, data, error: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ key, data: null, error: true });
        });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [url, key, delayMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const current = key !== null && answer?.key === key ? answer : null;
  return { data: current?.data ?? null, loading: key !== null && !current, error: current?.error ?? false, retry };
}
