/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5G implements it; 5B calls it from an ai_reply step that has `goals`).
// One turn of a goal-driven AI conversation: every AI message goes through the
// AI gate, budget and safety checks and the channel sender (Instagram window
// re-checked, outbound intent). Prompts and answers are never logged.
import type { FlowNodeRow, FlowRunRow, ParsedInbound } from '@/lib/flows/types';

export type GoalTurnResult =
  /** AI is off, out of budget or not configured: the step follows its handoff port. */
  | { outcome: 'unavailable' }
  /** A reply was sent; the step waits for the next message. `vars` are written to the run. */
  | { outcome: 'continue'; vars?: Record<string, string> }
  /** Every goal is met or given up: the step follows `finish_next`. */
  | { outcome: 'finished'; vars?: Record<string, string> }
  /** The person refused a capture_lead goal set to hand off, or the AI asked for a person. */
  | { outcome: 'handoff' };

/** Runs one goal turn. No-op until 5G: `unavailable`. */
export async function runGoalTurn(_run: FlowRunRow, _node: FlowNodeRow, _message: ParsedInbound | null): Promise<GoalTurnResult> {
  return { outcome: 'unavailable' };
}
