// Stage 5 (5G): goal-driven AI. An ai_reply step with `goals` (and the
// workspace's Instagram AI auto-reply with `instagram_goals`) works through up
// to three goals in order:
//
//   share_link       the AI shares one link when the person shows interest;
//                    met once a sent answer contains it
//   grow_followers   the AI invites the person to follow the account; met when
//                    the stored follow fact (contact_channel_identities) is true
//   capture_lead     the AI asks for the chosen details; answers are extracted
//                    by one model call per customer message, accepted only with
//                    high confidence and when they pass the existing input
//                    formats, then written through lib/contacts/field-write.ts.
//                    On refusal: hand off to a person, or give the goal up.
//
// Every AI message goes through runFlowAiReply (the AI gate, the plan budget,
// handoff keywords, sensitive topics, output guards and the channel sender with
// the window re-checked under an outbound intent). The extraction runs under
// its own outbound intent keyed by the inbound message, so a retry neither
// calls the model again nor writes twice. State lives in run variables
// (ai_goal_*). Prompts, answers and extracted values are never logged: log
// lines carry reason codes and field ids only.

import { z } from 'zod';
import { databaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { chatTokenEstimate, failAi, reserveAi, settleAi } from './budget';
import { generateReply } from './generate';
import { logAiEvent } from './log';
import { usageLog } from './usage';
import { redactForProvider } from './safety/redact';
import { delimitUntrusted } from './safety/untrusted';
import { parseJsonObject } from './task';
import { runFlowAiReply, type FlowAiOutcome } from './flow-reply';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { normalizeCollectedInput } from '@/lib/flows/input-validation';
import { writeContactField } from '@/lib/contacts/field-write';
import type { AiGoal, AiReplyNodeConfig, FlowNodeRow, FlowRunRow, ParsedInbound } from '@/lib/flows/types';
import {
  advanceGoals, autoReplyGoalInstructions, customFieldId, effectiveGoals, GOAL_MAX_TURNS, goalInstructions, goalStateVars, leadVar, missingLeadFields, parseGoals,
  readGoalState, type GoalFacts,
} from './goal-rules';

export * from './goal-rules';

export type GoalTurnResult =
  /** AI is off, out of budget or not configured: the step follows its handoff port. */
  | { outcome: 'unavailable' }
  /** A reply was sent; the step waits for the next message. `vars` are written to the run. */
  | { outcome: 'continue'; vars?: Record<string, string> }
  /** Every goal is met or given up: the step follows `finish_next`. */
  | { outcome: 'finished'; vars?: Record<string, string> }
  /** The person refused a capture_lead goal set to hand off, or the AI asked for a person. */
  | { outcome: 'handoff' };

/** An extracted value is used only at or above this confidence. */
export const EXTRACTION_MIN_CONFIDENCE = 0.8;
const EXTRACTION_TIMEOUT_MS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_FIELD_MAX = 100;
const CUSTOM_VALUE_MAX = 255;

// ---------------------------------------------------------------------------
// Lead extraction

const Extraction = z.object({
  values: z.record(z.string(), z.unknown()).optional(),
  confidence: z.record(z.string(), z.unknown()).optional(),
  refused: z.boolean().optional(),
});

export interface ExtractionResult {
  /** Accepted values by lead field (already validated). */
  values: Record<string, string>;
  refused: boolean;
}

/**
 * Keeps an extracted value only with confidence at or above
 * EXTRACTION_MIN_CONFIDENCE and when it passes its input format: email and
 * phone use the Ask Question formats; name, company and custom fields are one
 * line of plain text without links.
 */
export async function acceptExtracted(raw: unknown, fields: readonly string[]): Promise<ExtractionResult> {
  const parsed = Extraction.safeParse(raw);
  if (!parsed.success) return { values: {}, refused: false };
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = parsed.data.values?.[field];
    const confidence = parsed.data.confidence?.[field];
    if (typeof value !== 'string' || typeof confidence !== 'number' || !(confidence >= EXTRACTION_MIN_CONFIDENCE)) continue;
    const accepted = await validLeadValue(field, value);
    if (accepted !== null) values[field] = accepted;
  }
  return { values, refused: parsed.data.refused === true && Object.keys(values).length === 0 };
}

export async function validLeadValue(field: string, raw: string): Promise<string | null> {
  const value = raw.trim();
  if (field === 'email') return normalizeCollectedInput(value.toLowerCase(), { validation: 'email' });
  if (field === 'phone') return normalizeCollectedInput(value.replace(/[\s().-]/g, ''), { validation: 'phone' });
  const max = field.startsWith('custom:') ? CUSTOM_VALUE_MAX : TEXT_FIELD_MAX;
  if (!value || value.length > max || /[\r\n]/.test(value) || /(https?:\/\/|www\.)/i.test(value)) return null;
  return value;
}

function extractionPrompt(asked: readonly string[], fields: readonly string[], labels: Record<string, string>, instruction: string): string {
  return [
    'You read one customer message and pull out details the business asked for. Use only what the message states.',
    `The business asked for: ${asked.map((f) => labels[f] ?? f).join(', ')}.`,
    fields.length ? `Keys to extract (key: meaning): ${fields.map((f) => `${f}: ${labels[f] ?? f}`).join('; ')}.` : 'There are no keys to extract; values stays empty.',
    'Reply with one JSON object only: {"values": {key: string}, "confidence": {key: number between 0 and 1}, "refused": boolean}.',
    'Leave out keys the message does not state. Set "refused" to true only when the person clearly declines to share the details.',
    instruction,
  ].join('\n');
}

/**
 * Email addresses and phone numbers are read from the message without a model
 * (they are masked before any text leaves for the provider): the first one
 * that passes its input format.
 */
export async function extractContactPoints(text: string, fields: readonly string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (fields.includes('email')) {
    for (const m of text.match(/[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']+/g) ?? []) {
      const v = await validLeadValue('email', m.replace(/[.!?]+$/, ''));
      if (v) { values.email = v; break; }
    }
  }
  if (fields.includes('phone')) {
    for (const m of text.match(/\+?\d[\d\s().-]{6,18}\d/g) ?? []) {
      const v = await validLeadValue('phone', m);
      if (v) { values.phone = v; break; }
    }
  }
  return values;
}

/** Stored by the extraction intent; never logged. */
interface StoredExtraction { values: Record<string, string>; refused: boolean }

/** Where a lead is captured: the workspace, the conversation and a stable key of the step or auto-reply. */
interface LeadScope { accountId: string; conversationId: string; contactId: string; key: string }

async function extractLead(scope: LeadScope, messageId: string, text: string, fields: readonly string[],
  labels: Record<string, string>): Promise<ExtractionResult | null> {
  const accountId = scope.accountId;
  const points = await extractContactPoints(text, fields);
  const modelFields = fields.filter((f) => f !== 'email' && f !== 'phone');
  try {
    const stored = await dispatchOnce<StoredExtraction>(accountId, `ai-goal-extract:${scope.key}:${messageId}`, async () => {
      const config = await loadAiConfig(databaseAdmin({ accountId, role: 'owner' }), accountId);
      if (!config) return { values: {}, refused: false };
      // Personal data (email, phone, ids) is masked before the text leaves for the provider.
      const delimited = delimitUntrusted([{ source: 'customer', label: 'message', text: redactForProvider(text.slice(0, 2_000)).text }]);
      const systemPrompt = extractionPrompt(fields, modelFields, labels, delimited.instruction);
      const messages = [{ role: 'user' as const, content: delimited.text }];
      let reservation;
      try {
        reservation = await reserveAi(accountId, `goal-extract:${scope.key}:${messageId}`, { message: false, tokens: chatTokenEstimate(systemPrompt, messages, 300) });
      } catch (error) {
        if (error instanceof PlanLimitError) return { values: {}, refused: false };
        throw error;
      }
      let generated: Awaited<ReturnType<typeof generateReply>>;
      try {
        generated = await generateReply({ config, systemPrompt, messages, maxOutputTokens: 300, timeoutMs: EXTRACTION_TIMEOUT_MS });
      } catch (error) {
        await failAi(reservation, error, systemPrompt.length + delimited.text.length);
        logAiEvent({ feature: 'ai_goals', reason: 'extraction_failed', accountId, error });
        return { values: {}, refused: false };
      }
      const log = usageLog({
        conversationId: scope.conversationId, mode: 'auto_reply', provider: config.provider, model: config.model, usage: generated.usage,
        estimate: { promptChars: systemPrompt.length + delimited.text.length, outputChars: generated.text.length },
      });
      await settleAi(reservation, { tokens: log.totalTokens, log });
      return acceptExtracted(parseJsonObject(generated.text), modelFields);
    });
    const values = { ...stored.values, ...points };
    return { values, refused: stored.refused && Object.keys(values).length === 0 };
  } catch (error) {
    logAiEvent({ feature: 'ai_goals', reason: 'extraction_unavailable', accountId, error });
    // The deterministic part still counts; nothing from the model is used.
    return Object.keys(points).length ? { values: points, refused: false } : null;
  }
}

// ---------------------------------------------------------------------------
// Database reads and writes (worker role, tenant-scoped)

async function readFacts(accountId: string, conversationId: string): Promise<GoalFacts> {
  try {
    const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ follows_business: boolean | null }[]>`
      SELECT i.follows_business FROM conversations c
      JOIN contact_channel_identities i ON i.account_id=c.account_id AND i.contact_id=c.contact_id
        AND i.instagram_account_id=c.instagram_account_id
      WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid AND c.channel='instagram'
      ORDER BY i.created_at, i.id LIMIT 1`, getWorkerPrisma());
    return { followsBusiness: rows[0]?.follows_business ?? null };
  } catch {
    return { followsBusiness: null };
  }
}

/** Readable names for the lead fields: built-in names, and this workspace's custom field names. */
async function fieldLabels(accountId: string, fields: readonly string[]): Promise<Record<string, string>> {
  const labels: Record<string, string> = { name: 'full name', email: 'email address', phone: 'phone number', company: 'company name' };
  const ids = fields.map(customFieldId).filter((id): id is string => !!id);
  if (!ids.length) return labels;
  try {
    const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id::text AS id, field_name AS name FROM custom_fields WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[])`, getWorkerPrisma());
    for (const row of rows) labels[`custom:${row.id}`] = row.name.replace(/[\r\n]+/g, ' ').slice(0, 60);
  } catch {
    // Unknown labels fall back to the key.
  }
  return labels;
}

/**
 * Writes accepted values to the run's own contact through field-write (a
 * custom field of another workspace, or a phone or email it refuses, is not
 * written; the value stays in the run variable). Returns the written field ids.
 */
async function writeLead(scope: LeadScope, values: Record<string, string>): Promise<string[]> {
  const db = databaseAdmin({ accountId: scope.accountId, role: 'owner' });
  const written: string[] = [];
  for (const [field, value] of Object.entries(values)) {
    try {
      if (await writeContactField(db, scope.accountId, scope.contactId, field, value)) written.push(field);
    } catch (error) {
      logAiEvent({ feature: 'ai_goals', reason: 'lead_write_failed', accountId: scope.accountId, flags: [field], error });
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// The turn

function messageText(message: ParsedInbound | null): string | null {
  if (!message) return null;
  if (message.kind === 'text') return message.text;
  if (message.kind === 'interactive_reply') return message.reply_title;
  return null;
}

function messageIdOf(message: ParsedInbound | null): string | null {
  return message && typeof (message as { meta_message_id?: unknown }).meta_message_id === 'string'
    ? (message as { meta_message_id: string }).meta_message_id : null;
}

/** One goal turn of an ai_reply step with goals. Never throws. */
export async function runGoalTurn(run: FlowRunRow, node: FlowNodeRow, message: ParsedInbound | null): Promise<GoalTurnResult> {
  try {
    const cfg = node.config as unknown as Partial<AiReplyNodeConfig>;
    if (!run.conversation_id || !run.contact_id || !UUID.test(run.account_id)) return { outcome: 'unavailable' };
    const goals = effectiveGoals(cfg);
    if (!goals.length) return { outcome: 'finished' };

    const vars: Record<string, unknown> = { ...run.vars };
    const out: Record<string, string> = {};
    let state = readGoalState(vars);
    const scope: LeadScope = { accountId: run.account_id, conversationId: run.conversation_id, contactId: run.contact_id, key: run.id };
    const facts = await readFacts(run.account_id, run.conversation_id);
    const messageId = messageIdOf(message);
    const text = messageText(message);

    // The person's answer to a capture_lead goal: extract, validate, write.
    state = advanceGoals(goals, state, vars, facts);
    const current = goals[state.step];
    if (current?.type === 'capture_lead' && text && messageId) {
      const missing = missingLeadFields(current, vars);
      const labels = await fieldLabels(run.account_id, missing);
      const extracted = await extractLead(scope, messageId, text, missing, labels);
      if (extracted) {
        for (const [field, value] of Object.entries(extracted.values)) {
          vars[leadVar(field)] = value;
          out[leadVar(field)] = value;
        }
        const written = await writeLead(scope, extracted.values);
        if (Object.keys(extracted.values).length)
          logAiEvent({ feature: 'ai_goals', reason: 'lead_captured', accountId: run.account_id, flags: written });
        if (extracted.refused) {
          logAiEvent({ feature: 'ai_goals', reason: 'lead_refused', accountId: run.account_id });
          if (current.on_refusal === 'handoff') return { outcome: 'handoff' };
          state = { ...state, step: state.step + 1, linkShared: false };
        }
      }
    }

    state = advanceGoals(goals, state, vars, facts);
    if (state.step >= goals.length || state.turns >= GOAL_MAX_TURNS) {
      return { outcome: 'finished', vars: { ...out, ...goalStateVars({ ...state, step: goals.length }) } };
    }

    const goal = goals[state.step];
    const labels = goal.type === 'capture_lead' ? await fieldLabels(run.account_id, goal.fields) : {};
    const guidance = goalInstructions(goal, goal.type === 'capture_lead' ? missingLeadFields(goal, vars) : [], labels);
    const intentKey = `flow-ai-goal:${run.id}:${node.node_key}:${messageId ?? `entry:${run.transition_seq ?? 0}`}`;
    const outcome: FlowAiOutcome = await runFlowAiReply({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      config: cfg,
      goalGuidance: guidance,
      intentKey,
      allowedUrls: goal.type === 'share_link' ? [goal.url] : [],
    });
    if (outcome.kind === 'handoff') return { outcome: 'handoff' };
    if (outcome.kind === 'unavailable') {
      // The answer may have reached the person: never continue with more bot messages on top of it.
      if (outcome.reason === 'send_uncertain' || outcome.reason === 'turn_uncertain') return { outcome: 'handoff' };
      return { outcome: 'unavailable' };
    }
    state = { ...state, turns: state.turns + 1 };
    if (goal.type === 'share_link' && outcome.text.includes(goal.url)) state = { ...state, linkShared: true };
    const after = advanceGoals(goals, state, vars, facts);
    const finished = after.step >= goals.length;
    const varsOut = { ...out, ...(cfg.var_key ? { [cfg.var_key]: outcome.text.slice(0, 4096) } : {}), ...goalStateVars(after) };
    return finished ? { outcome: 'finished', vars: varsOut } : { outcome: 'continue', vars: varsOut };
  } catch (error) {
    logAiEvent({ feature: 'ai_goals', reason: 'turn_failed', accountId: run.account_id, error });
    return { outcome: 'unavailable' };
  }
}


// ---------------------------------------------------------------------------
// The workspace's Instagram AI auto-reply (ai_workspace_settings.instagram_goals)

export type AutoReplyGoals =
  | { kind: 'none' }
  /** The person declined a capture_lead goal set to hand off. */
  | { kind: 'handoff' }
  | { kind: 'instructions'; instructions: string; allowedUrls: string[] };

/**
 * The goal guidance for one Instagram auto-reply: reads the workspace's goals,
 * captures lead details from the inbound message (same extraction, intent
 * and field-write rules as the flow step, keyed by the conversation), and
 * returns the instructions for the first goal still open. 'none' when there
 * are no goals or on any failure (the auto-reply then answers as before).
 */
export async function instagramAutoReplyGoals(args: { accountId: string; conversationId: string; contactId: string;
  inboundMessageId: string | null; latestText: string }): Promise<AutoReplyGoals> {
  try {
    const goals = await withTenant({ accountId: args.accountId, role: 'owner' }, async (tx) => {
      const [row] = await tx.$queryRaw<{ instagram_goals: unknown }[]>`
        SELECT instagram_goals FROM ai_workspace_settings WHERE account_id=${args.accountId}::uuid`;
      return parseGoals(row?.instagram_goals);
    }, getWorkerPrisma());
    if (!goals.length) return { kind: 'none' };
    const facts = await readFacts(args.accountId, args.conversationId);
    const scope: LeadScope = { accountId: args.accountId, conversationId: args.conversationId, contactId: args.contactId,
      key: `conv:${args.conversationId}` };
    const fields = [...new Set(goals.flatMap((g) => (g.type === 'capture_lead' ? g.fields : [])))];
    const values: Record<string, string | null> = fields.length ? await contactLeadValues(args.accountId, args.contactId, fields) : {};
    const lead = goals.find((g): g is Extract<AiGoal, { type: 'capture_lead' }> => g.type === 'capture_lead');
    const missing = lead ? lead.fields.filter((f) => !values[f]) : [];
    if (lead && missing.length && args.inboundMessageId && args.latestText.trim()) {
      const extracted = await extractLead(scope, args.inboundMessageId, args.latestText, missing, await fieldLabels(args.accountId, missing));
      if (extracted) {
        Object.assign(values, extracted.values);
        const written = await writeLead(scope, extracted.values);
        if (Object.keys(extracted.values).length) logAiEvent({ feature: 'ai_goals', reason: 'lead_captured', accountId: args.accountId, flags: written });
        if (extracted.refused && lead.on_refusal === 'handoff') return { kind: 'handoff' };
        // Declined and set to continue: the goal is given up for this answer.
        if (extracted.refused) for (const f of missing) values[f] ??= 'declined';
      }
    }
    const labels = await fieldLabels(args.accountId, fields);
    const next = autoReplyGoalInstructions(goals, facts, values, labels);
    return next ? { kind: 'instructions', ...next } : { kind: 'none' };
  } catch (error) {
    logAiEvent({ feature: 'ai_goals', reason: 'auto_reply_goals_failed', accountId: args.accountId, error });
    return { kind: 'none' };
  }
}

/** The contact's current values for lead fields (built-in columns and custom values), read with the worker role. */
async function contactLeadValues(accountId: string, contactId: string, fields: readonly string[]): Promise<Record<string, string | null>> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [contact] = await tx.$queryRaw<{ name: string | null; email: string | null; phone: string | null; company: string | null }[]>`
      SELECT name, email, phone, company FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
    const out: Record<string, string | null> = {};
    for (const f of ['name', 'email', 'phone', 'company'] as const) if (fields.includes(f)) out[f] = contact?.[f] ?? null;
    const ids = fields.map(customFieldId).filter((id): id is string => !!id);
    if (ids.length) {
      const rows = await tx.$queryRaw<{ custom_field_id: string; value: string | null }[]>`
        SELECT v.custom_field_id::text AS custom_field_id, v.value FROM contact_custom_values v
        JOIN custom_fields f ON f.id=v.custom_field_id AND f.account_id=${accountId}::uuid
        WHERE v.contact_id=${contactId}::uuid AND v.custom_field_id = ANY(${ids}::uuid[])`;
      for (const r of rows) out[`custom:${r.custom_field_id}`] = r.value;
    }
    return out;
  }, getWorkerPrisma());
}
