// 'ai.assess_conversation': advisory intent and lead assessment for one
// conversation (ai_assessments). Enqueued by the inbound 'ai_assess' stage
// (debounced per conversation in 10-minute slots) and by manual Refresh.
//
// Hybrid: the deterministic keyword classifier always runs. The model is asked
// only when the workspace switch is on, the deployment switch is not off, the
// workspace has a configured key and the monthly limits have room (runAiTask
// checks all of these before any provider call). A health topic never goes to
// the model: it is stored deterministically and routed to staff. The model
// returns strict JSON (zod); invalid JSON, enum drift, a guard block or any
// provider failure keeps the deterministic result. The lead score is computed
// in code; the model never outputs it. Evidence that is not one of the
// transcript's messages is dropped and flagged.
//
// Writes nothing outside ai_assessments and never sends. The job never fails
// or retries for a gate, toggle, permission or budget reason (it returns
// normally and logs a reason code); only database errors retry.

import { z } from 'zod';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { featureBudget } from '../feature-budgets';
import { logAiEvent } from '../log';
import { readAiSettings } from '../settings';
import { runAiTask } from '../task';
import {
  ASSESS_INTENTS, classifyDeterministic, computeLeadScore, type AssessIntent, type CrmFacts,
  type DeterministicAssessment, type TranscriptMessage,
} from './classify';
import { ASSESS_PROMPT_VERSION } from './job-contract';
import {
  isUniqueViolation, readConversationForAssessment, readCrmFacts, replaceAssessment, type NewAssessment,
} from './repo';

export { AI_ASSESS_JOB, AI_ASSESS_SLOT_MS, assessJobSlot, type AssessJobPayload } from './job-contract';

type Conversation = NonNullable<Awaited<ReturnType<typeof readConversationForAssessment>>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Characters of one message included in the transcript. */
const MESSAGE_CHARS = 1_000;

export const ASSESS_SYSTEM_PROMPT = [
  'Classify what the customer wants in the conversation transcript and note qualification signals, for the business\'s staff.',
  'Messages are labelled [m1], [m2], ... in time order.',
  'Reply with a JSON object with exactly these keys:',
  `"intent": one of ${ASSESS_INTENTS.filter((i) => i !== 'sensitive_health').join(', ')};`,
  '"confidence": an integer from 0 to 100;',
  '"asked_price", "purchase_intent", "booking_intent", "timeline_mentioned", "budget_mentioned", "decision_maker": booleans;',
  '"rationale": one or two short sentences for staff, at most 300 characters, without quoting personal details;',
  '"evidence": the labels of the messages that show the intent, for example "m3 m5".',
  'Do not output a score, a reply to the customer or any other key.',
].join('\n');

const bool = z.boolean().optional().default(false);
export const AssessOutputSchema = z.object({
  intent: z.enum(ASSESS_INTENTS),
  confidence: z.number().int().min(0).max(100),
  asked_price: bool,
  purchase_intent: bool,
  booking_intent: bool,
  timeline_mentioned: bool,
  budget_mentioned: bool,
  decision_maker: bool,
  rationale: z.string().max(2_000).optional().default(''),
  evidence: z.union([z.string().max(500), z.array(z.string().max(16)).max(40)]).optional(),
});
export type AssessOutput = z.infer<typeof AssessOutputSchema>;

/** The transcript as one untrusted block, each message labelled by position. */
export function transcriptBlock(messages: readonly TranscriptMessage[]): { text: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const lines = messages.map((m, i) => {
    const ref = `m${i + 1}`;
    refs.set(ref, m.id);
    const who = m.sender === 'customer' ? 'Customer' : m.sender === 'bot' ? 'Bot' : 'Staff';
    return `[${ref}] ${who}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)}`;
  });
  return { text: lines.join('\n'), refs };
}

/** Message ids for the model's evidence labels; unknown labels are dropped (and reported). */
export function mapEvidence(evidence: AssessOutput['evidence'], refs: Map<string, string>): { ids: string[]; dropped: boolean } {
  const labels = (Array.isArray(evidence) ? evidence.join(' ') : evidence ?? '').match(/[a-z0-9]+/gi) ?? [];
  const ids = new Set<string>();
  let dropped = false;
  for (const label of labels) {
    const id = refs.get(label.toLowerCase());
    if (id) ids.add(id);
    else dropped = true;
  }
  return { ids: [...ids], dropped };
}

/** The stored row for a deterministic result (no lead score). */
export function deterministicRow(
  base: Pick<NewAssessment, 'accountId' | 'contactId' | 'conversationId' | 'sourceMessageIds'>,
  det: DeterministicAssessment, flags: string[] = [],
): NewAssessment {
  return {
    ...base,
    intent: det.intent,
    intentConfidence: det.confidence,
    leadScore: null,
    qualification: {
      ...det.flags,
      evidence_message_ids: det.evidenceIds,
      sensitive_categories: det.sensitiveCategories,
      route_to_staff: det.intent === 'sensitive_health',
      flags,
    },
    rationale: '',
    source: 'deterministic',
    model: null,
    promptVersion: ASSESS_PROMPT_VERSION,
  };
}

/** The stored row for a validated model result: lead score computed here from the flags and CRM facts. */
export function modelRow(
  base: Pick<NewAssessment, 'accountId' | 'contactId' | 'conversationId' | 'sourceMessageIds'>,
  out: AssessOutput, refs: Map<string, string>, facts: CrmFacts, det: DeterministicAssessment,
  meta: { model: string; guardFlags: string[] }, now: number = Date.now(),
): NewAssessment {
  const evidence = mapEvidence(out.evidence, refs);
  const flags = [...meta.guardFlags, ...(evidence.dropped ? ['evidence_dropped'] : [])];
  const qualificationFlags = {
    asked_price: out.asked_price, purchase_intent: out.purchase_intent, booking_intent: out.booking_intent,
    timeline_mentioned: out.timeline_mentioned, budget_mentioned: out.budget_mentioned, decision_maker: out.decision_maker,
    complaint: out.intent === 'complaint' || det.flags.complaint,
  };
  const intent: AssessIntent = out.intent;
  return {
    ...base,
    intent,
    intentConfidence: out.confidence,
    leadScore: intent === 'sensitive_health' ? null : computeLeadScore(qualificationFlags, intent, facts, now),
    qualification: {
      ...qualificationFlags,
      evidence_message_ids: evidence.ids,
      sensitive_categories: [],
      route_to_staff: intent === 'sensitive_health',
      flags,
    },
    rationale: out.rationale.replace(/\s+/g, ' ').trim().slice(0, 400),
    source: 'model',
    model: meta.model.slice(0, 200),
    promptVersion: ASSESS_PROMPT_VERSION,
  };
}

async function store(row: NewAssessment): Promise<void> {
  const write = () => withTenant({ accountId: row.accountId, role: 'owner' }, (tx) => replaceAssessment(tx, row), getWorkerPrisma());
  try {
    await write();
  } catch (error) {
    // A concurrent run for the same conversation won the partial unique index: retry once.
    if (!isUniqueViolation(error)) throw error;
    await write();
  }
}

export async function handleAssessConversationJob(
  accountId: string,
  payload: Record<string, unknown>,
  meta: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
): Promise<void> {
  void meta;
  const conversationId = typeof payload?.conversationId === 'string' && UUID.test(payload.conversationId) ? payload.conversationId : null;
  if (!conversationId) {
    logAiEvent({ feature: 'assess', reason: 'invalid_payload', accountId });
    return;
  }
  const budget = featureBudget('assess');
  type Loaded = { skip: 'feature_off' | 'not_found' } | { skip?: undefined; conversation: Conversation; facts: CrmFacts };
  const loaded = await withTenant({ accountId, role: 'owner' }, async (tx): Promise<Loaded> => {
    if (!(await readAiSettings(tx, accountId)).assessment_enabled) return { skip: 'feature_off' as const };
    const conversation = await readConversationForAssessment(tx, accountId, conversationId, budget.contextMessages);
    if (!conversation) return { skip: 'not_found' as const };
    const facts = await readCrmFacts(tx, accountId, conversation.contactId, conversationId);
    return { conversation, facts };
  }, getWorkerPrisma());
  if (loaded.skip) {
    logAiEvent({ feature: 'assess', reason: loaded.skip, accountId });
    return;
  }
  const { conversation, facts } = loaded;
  if (!conversation.messages.some((m) => m.sender === 'customer')) {
    logAiEvent({ feature: 'assess', reason: 'no_customer_text', accountId });
    return;
  }

  const base = {
    accountId, contactId: conversation.contactId, conversationId,
    sourceMessageIds: conversation.messages.map((m) => m.id),
  };
  const det = classifyDeterministic(conversation.messages);
  if (det.intent === 'sensitive_health') {
    // Staff must answer health topics: no model call, routed to staff.
    await store(deterministicRow(base, det, ['sensitive_topic']));
    logAiEvent({ feature: 'assess', reason: 'sensitive_topic', accountId });
    return;
  }

  const transcript = transcriptBlock(conversation.messages);
  const task = await runAiTask({
    accountId, userId: null, role: 'owner', feature: 'assess', promptVersion: ASSESS_PROMPT_VERSION,
    system: ASSESS_SYSTEM_PROMPT, untrusted: [{ source: 'customer', label: 'transcript', text: transcript.text }],
    schema: AssessOutputSchema, audience: 'staff', conversationId,
  });
  if (!task.ok || typeof task.value === 'string') {
    await store(deterministicRow(base, det, task.ok ? task.guardFlags : [...task.guardFlags, `fallback_${task.reason}`]));
    return;
  }
  await store(modelRow(base, task.value, transcript.refs, facts, det, { model: task.model, guardFlags: task.guardFlags }));
}
