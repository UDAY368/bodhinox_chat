/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5G implements it; 5B calls it from a google_sheets step). Requests go
// to the fixed Google API host with a timeout, and the run and step are the
// idempotency marker stored after success; an unknown outcome is never retried
// automatically (failure port, event `sheets_outcome_unknown`). Cell values are
// never logged.
import type { FlowNodeRow, FlowRunRow } from '@/lib/flows/types';

export interface SheetsNodeResult {
  /** `next` on success, `failure` otherwise (unknown outcome included). */
  port: 'next' | 'failure';
  /** Run variables set by a get_row step (var_map). */
  vars: Record<string, string>;
  /** A machine reason for the run event, never a cell value. */
  reason?: 'not_connected' | 'not_enabled' | 'sheets_outcome_unknown' | 'sheets_failed' | 'not_found';
}

/** Runs a Google Sheets step. No-op until 5G: the failure port. */
export async function executeSheetsNode(_run: FlowRunRow, _node: FlowNodeRow): Promise<SheetsNodeResult> {
  return { port: 'failure', vars: {}, reason: 'not_enabled' };
}
