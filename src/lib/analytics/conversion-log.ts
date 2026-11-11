/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5F implements it; 5B calls it from the Actions step). An internal
// conversion log: one conversion_event_log row per run, step and event type
// (unique key, so a replay does not double count). Not the Meta Conversions
// API, which keeps its own conversion_event step.
import type { Channel } from '@/types';

export interface ConversionLogInput {
  eventTypeId: string;
  contactId: string | null;
  flowId: string | null;
  runId: string | null;
  nodeKey: string | null;
  channel: Channel;
}

/** Records a conversion. No-op until 5F: writes nothing. */
export async function logConversion(_accountId: string, _input: ConversionLogInput): Promise<void> {
  // 5F: INSERT ... ON CONFLICT (account_id, flow_run_id, node_key, event_type_id) DO NOTHING.
}
