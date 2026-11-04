// Structured, content-free logging for AI paths.
//
// Only allowlisted fields are written: a feature name, a reason code, the
// provider and model ids, latency, token counts and guard flags. Never the
// prompt, the model output, customer text, error messages or database error
// objects (Postgres errors can carry row values). Errors are reduced to their
// class name. The account id is logged as an 8-character hash.

import { createHash } from 'node:crypto';

export interface AiLogEvent {
  /** Feature or code path, e.g. 'summary', 'draft', 'config', 'usage'. */
  feature: string;
  /** Short reason code, e.g. 'ok', 'quota', 'provider_error', 'insert_failed'. */
  reason: string;
  accountId?: string | null;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  tokens?: number | null;
  flags?: readonly string[];
  /** An error, logged by class name only. */
  error?: unknown;
}

const CODE = /^[a-z0-9_.:-]{1,64}$/i;

/** The account id as a short stable hash (never the raw id). */
export function hashAccount(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 8);
}

/** The error's class name, or 'unknown'; never its message. */
export function errorName(error: unknown): string {
  return error instanceof Error && CODE.test(error.name) ? error.name : 'unknown';
}

const safe = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' && CODE.test(value) ? value : undefined;

/** The exact object written to the log, for tests. */
export function aiLogRecord(event: AiLogEvent): Record<string, unknown> {
  const record: Record<string, unknown> = { feature: safe(event.feature) ?? 'unknown', reason: safe(event.reason) ?? 'unknown' };
  if (event.accountId) record.account = hashAccount(event.accountId);
  const provider = safe(event.provider);
  if (provider) record.provider = provider;
  // Model ids are free text an admin typed; keep only a plain id shape.
  const model = typeof event.model === 'string' && /^[a-z0-9_./:@-]{1,100}$/i.test(event.model) ? event.model : undefined;
  if (model) record.model = model;
  if (typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs)) record.latencyMs = Math.round(event.latencyMs);
  if (typeof event.tokens === 'number' && Number.isFinite(event.tokens)) record.tokens = Math.round(event.tokens);
  const flags = (event.flags ?? []).map((f) => safe(f)).filter((f): f is string => !!f).slice(0, 16);
  if (flags.length) record.flags = flags;
  if (event.error !== undefined) record.error = errorName(event.error);
  return record;
}

/** Writes one content-free line. Errors go to console.error, everything else to console.info. */
export function logAiEvent(event: AiLogEvent): void {
  const record = aiLogRecord(event);
  if (event.error !== undefined) console.error('[ai]', record);
  else console.info('[ai]', record);
}
