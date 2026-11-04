// Conversation summaries and suggested replies for staff. Synchronous: the
// member is waiting, nothing is queued, and every failure returns a fallback
// reason the UI explains. Nothing here sends anything: a suggested reply is
// only ever inserted into the composer, and a member presses Send.
//
// Order for both: the conversation must be visible to the member (else
// not_found), the workspace switch, permission, config and limits must allow
// the feature (isAiFeatureAvailable, no provider call), then context is read
// by the fixed providers, then one runAiTask call (redaction, delimiting,
// budget before the call, guards after it).
//
// Suggested replies: when a customer turn since the last reply is a health
// or other sensitive topic, no reply text is generated at all; a 'route_to_staff'
// suggestion (category only) is stored and shown instead.

import { withTenant } from '@/lib/db/tenant';
import type { AccountRole } from '@/lib/auth/roles';
import { loadAgentProfileTx, type AgentProfile } from '../agent-profile';
import { isAiFeatureAvailable } from '../settings';
import { runAiTask } from '../task';
import { classifySensitive, type SensitiveCategory } from '../safety/sensitive';
import type { AiFallbackReason, KnowledgeCitation } from '../types';
import { loadContext, type ContextRequest } from '../context-providers';
import { latestCustomerText, loadTranscript, recentCustomerTextOf, transcriptBlock } from '../context-providers/conversation';
import { featureBudget, maxTokensFor } from '../feature-budgets';
import { requireAiBudget } from '../budget';
import { redactForProvider } from '../safety/redact';
import { AuthError } from '@/lib/auth/errors';
import { isHealthWorkspace, urlAllowlist } from './guards';
import {
  MAX_REPLY_OPTIONS, REPLIES_PROMPT_VERSION, REPLIES_SYSTEM, repliesSchema, SUMMARY_PROMPT_VERSION, SUMMARY_SYSTEM,
  summarySchema, type RepliesOutput, type SummaryOutput,
} from './prompts';
import { insertSuggestions } from './suggestions';

export interface AssistMember {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export type AssistFailureReason = AiFallbackReason | 'not_found' | 'no_messages';
export type AssistFailure = { ok: false; reason: AssistFailureReason; guardFlags: string[] };

export interface SummaryResult {
  ok: true;
  suggestionId: string;
  summary: string;
  openQuestions: string[];
  nextSteps: string[];
  /** When the records were read (ISO). */
  dataAsOf: string;
  guardFlags: string[];
  /** Sensitive categories in the latest customer turn (a "route to qualified staff" banner). */
  sensitive: SensitiveCategory[];
}

export interface ReplyOption {
  suggestionId: string;
  text: string;
}

export interface RepliesResult {
  ok: true;
  options: ReplyOption[];
  citations: KnowledgeCitation[];
  guardFlags: string[];
  /** Set instead of options when the latest customer turn is sensitive. */
  routeToStaff: { suggestionId: string; categories: SensitiveCategory[] } | null;
}

const fail = (reason: AssistFailureReason, guardFlags: string[] = []): AssistFailure => ({ ok: false, reason, guardFlags });

const requestFor = (member: AssistMember, conversationId: string, audience: 'staff' | 'customer', maxMessages: number): ContextRequest => ({
  accountId: member.accountId, userId: member.userId, role: member.role, audience, conversationId, maxMessages,
});

/** A staff-facing summary of one conversation, stored as an 'ai_suggestions' summary row. */
export async function summarizeConversation(member: AssistMember, conversationId: string): Promise<SummaryResult | AssistFailure> {
  const request = requestFor(member, conversationId, 'staff', featureBudget('summary').contextMessages);
  const transcript = await loadTranscript(request);
  if (!transcript) return fail('not_found');
  if (!transcript.messages.length) return fail('no_messages');
  const availability = await withTenant(member, (tx) => isAiFeatureAvailable(tx, member, 'summary'));
  if (!availability.ok) return fail(availability.reason);

  const context = await loadContext(['contactBasics', 'openDeal', 'orderStatus', 'appointmentStatus'], request);
  const result = await runAiTask<SummaryOutput>({
    accountId: member.accountId, userId: member.userId, role: member.role, feature: 'summary',
    promptVersion: SUMMARY_PROMPT_VERSION, system: SUMMARY_SYSTEM, schema: summarySchema, audience: 'staff',
    untrusted: [transcriptBlock(transcript), ...context.blocks], conversationId,
  });
  if (!result.ok) return fail(result.reason, result.guardFlags);
  const value = result.value as SummaryOutput;
  const [suggestionId] = await withTenant(member, (tx) => insertSuggestions(tx, member, [{
    conversationId, kind: 'summary', output: { ...value }, guardFlags: result.guardFlags,
    provider: result.provider, model: result.model, promptVersion: SUMMARY_PROMPT_VERSION,
  }]));
  return {
    ok: true, suggestionId, summary: value.summary, openQuestions: value.openQuestions, nextSteps: value.nextSteps,
    dataAsOf: context.dataAsOf, guardFlags: result.guardFlags, sensitive: classifySensitive(recentCustomerTextOf(transcript)).categories,
  };
}

/** Up to `count` reply options for the latest customer message (or a route-to-staff item), each stored for review. */
export async function suggestReplies(member: AssistMember, conversationId: string, count: number): Promise<RepliesResult | AssistFailure> {
  const wanted = Math.max(1, Math.min(MAX_REPLY_OPTIONS, Math.floor(count) || MAX_REPLY_OPTIONS));
  const request = requestFor(member, conversationId, 'customer', featureBudget('suggest').contextMessages);
  const transcript = await loadTranscript(request);
  if (!transcript) return fail('not_found');
  const latest = latestCustomerText(transcript);
  if (!latest.trim()) return fail('no_messages');

  const prep = await withTenant(member, async (tx) => {
    const availability = await isAiFeatureAvailable(tx, member, 'suggest');
    if (!availability.ok) return { availability } as const;
    const profile: AgentProfile | null = await loadAgentProfileTx(tx, member.accountId).catch(() => null);
    return { availability, profile, health: await isHealthWorkspace(tx, member.accountId, profile) } as const;
  });
  if (!prep.availability.ok) return fail(prep.availability.reason);

  // A health or safety-sensitive question gets no generated text: staff answer
  // it. Every customer turn since the last reply is checked (a burst).
  const sensitive = classifySensitive(recentCustomerTextOf(transcript));
  if (sensitive.sensitive) {
    const [suggestionId] = await withTenant(member, (tx) => insertSuggestions(tx, member, [{
      conversationId, kind: 'route_to_staff', output: { categories: sensitive.categories },
      guardFlags: ['sensitive_topic'], promptVersion: REPLIES_PROMPT_VERSION,
    }]));
    return { ok: true, options: [], citations: [], guardFlags: ['sensitive_topic'], routeToStaff: { suggestionId, categories: sensitive.categories } };
  }

  // Knowledge retrieval can call the embeddings provider: check the token
  // budget first (runAiTask repeats the exact check before the chat call).
  const budget = featureBudget('suggest');
  try {
    await requireAiBudget(member.accountId, 'suggest', maxTokensFor('suggest', transcriptBlock(transcript).text.slice(-budget.maxInputChars)));
  } catch (error) {
    if (error instanceof AuthError && error.status === 402) return fail('quota');
    throw error;
  }
  const context = await loadContext(['contactBasics', 'knowledge'], { ...request, query: redactForProvider(latest).text });
  const allow = urlAllowlist({
    citations: context.citations,
    profile: prep.profile ?? null,
  });
  const result = await runAiTask<RepliesOutput>({
    accountId: member.accountId, userId: member.userId, role: member.role, feature: 'suggest',
    promptVersion: REPLIES_PROMPT_VERSION, system: REPLIES_SYSTEM(wanted), schema: repliesSchema, audience: 'customer',
    untrusted: [transcriptBlock(transcript), ...context.blocks], conversationId, citations: context.citations,
    allowedUrls: allow.urls, allowedOrigins: allow.origins, healthWorkspace: prep.health ?? false,
  });
  if (!result.ok) return fail(result.reason, result.guardFlags);
  const texts = [...new Set((result.value as RepliesOutput).replies.map((r) => r.trim()).filter(Boolean))].slice(0, wanted);
  if (!texts.length) return fail('invalid_output', result.guardFlags);
  const ids = await withTenant(member, (tx) => insertSuggestions(tx, member, texts.map((text) => ({
    conversationId, kind: 'reply' as const, output: { text }, citations: result.citations, guardFlags: result.guardFlags,
    provider: result.provider, model: result.model, promptVersion: REPLIES_PROMPT_VERSION,
  }))));
  return {
    ok: true, options: texts.map((text, i) => ({ suggestionId: ids[i], text })), citations: result.citations,
    guardFlags: result.guardFlags, routeToStaff: null,
  };
}

/** Which assistant features this member can use now (no provider call). */
export async function assistAvailability(member: AssistMember): Promise<Record<'summary' | 'suggest', { ok: boolean; reason: AiFallbackReason | null }>> {
  return withTenant(member, async (tx) => {
    const summary = await isAiFeatureAvailable(tx, member, 'summary');
    const suggest = await isAiFeatureAvailable(tx, member, 'suggest');
    return {
      summary: { ok: summary.ok, reason: summary.ok ? null : summary.reason },
      suggest: { ok: suggest.ok, reason: suggest.ok ? null : suggest.reason },
    };
  });
}
