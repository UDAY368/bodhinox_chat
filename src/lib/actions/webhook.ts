// Outbound HTTP calls shared by rules (send_webhook) and flows (api_request): one request
// builder and runner (flows/api-request.ts) with the same SSRF guard (safeFetch dials only the
// address it checked, follows no redirect and caps time and size), placeholders filled the same
// way, and the JSON reply mapped into variables. The call is recorded under the caller's
// outbound intent key, so a replayed step reuses its outcome instead of calling again.
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { runApiRequest, type RequestValues } from '@/lib/flows/api-request';
import type { ApiRequestNodeConfig } from '@/lib/flows/types';

export interface ApiCallOutcome {
  /** The HTTP status, or null when no reply came (refused, timeout, network). */
  status: number | null;
  error: 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'network' | null;
  /** Variables mapped from a 2xx JSON reply (cfg.mappings). */
  mapped: Record<string, string>;
  /** The route the status picked (flows), else cfg.fallback_next. */
  next: string;
  durationMs: number;
}

/** A network error or timeout under `uncertainIsUnknown`: the receiver may or may not have the request. */
export class ApiCallOutcomeUnknown extends Error {
  constructor() { super('api call outcome unknown'); this.name = 'ApiCallOutcomeUnknown'; }
}

/**
 * Calls the API once under `key`. With `uncertainIsUnknown` (rules), a timeout or network error
 * throws inside the intent, which is then left 'unknown' for reconciliation and never re-sent;
 * otherwise (flows) it is recorded as the outcome and the step takes its fallback route.
 * `rawBody` is sent as it is, never filled (a rule's default body: the trigger context as JSON).
 */
export function callApiOnce(input: {
  accountId: string;
  key: string;
  config: ApiRequestNodeConfig;
  values: RequestValues;
  rawBody?: string;
  uncertainIsUnknown?: boolean;
}): Promise<ApiCallOutcome> {
  return dispatchOnce<ApiCallOutcome>(input.accountId, input.key, async () => {
    const o = await runApiRequest(input.config, input.values, input.rawBody);
    if (input.uncertainIsUnknown && !o.result.ok && (o.result.error === 'timeout' || o.result.error === 'network')) {
      throw new ApiCallOutcomeUnknown();
    }
    return {
      status: o.result.ok ? o.result.status : null,
      error: o.result.ok ? null : o.result.error,
      mapped: o.mapped,
      next: o.next,
      durationMs: o.durationMs,
    };
  });
}
