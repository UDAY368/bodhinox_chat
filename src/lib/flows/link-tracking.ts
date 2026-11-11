/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5F implements it, 5B calls it). Tracked links for flow buttons:
// trackedUrl creates (or reuses, by run, node key and slot) a 32-hex token in
// flow_tracked_links and returns `<app origin>/r/<token>`; /r/[token] records
// the click and redirects. Until 5F lands, links go out untracked.
import type { FlowRunRow } from './types';

/** The run fields link tracking needs. */
export type TrackedLinkRun = Pick<FlowRunRow, 'id' | 'account_id' | 'flow_id' | 'contact_id' | 'conversation_id'>;

/**
 * The URL to send for a button. No-op: returns `url` unchanged (no row is
 * written), so a send before 5F behaves exactly as before Stage 5.
 */
export async function trackedUrl(_run: TrackedLinkRun, _nodeKey: string, _slot: string, url: string): Promise<string> {
  return url;
}

/** Whether the contact clicked a tracked link sent by this run's step. No-op: false. */
export async function linkClicked(_accountId: string, _runId: string, _nodeKey: string): Promise<boolean> {
  return false;
}
