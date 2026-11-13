// Translation (Assistant features): for staff in the inbox, on request only.
//
//   incoming: the customer's latest messages (since the last reply), shown to
//             staff in the team language (ai_workspace_settings.translation_language).
//   outgoing: the member's draft, rewritten in the language the customer
//             writes in, put back into the composer; the member still presses Send.
//
// Nothing is sent or stored. Each call is one runAiTask: the deployment
// switch, the member's permission ('ai.assist'), the workspace switch, a
// configured key and the monthly budget (including the workspace cap while
// "pause the AI when the budget is used up" is on) are checked before the
// call, and the call is metered (mode 'translate'). A draft translation is
// customer-facing, so the output guards apply (a blocked text is never
// returned). Customer text is never logged.

import { z } from 'zod'
import { withTenant } from '@/lib/db/tenant'
import { featureBudget } from '../feature-budgets'
import { isAiFeatureAvailable, readAiSettings, TRANSLATION_LANGUAGE_NAMES, type TranslationLanguage } from '../settings'
import { runAiTask } from '../task'
import { latestCustomerText, loadTranscript, recentCustomerTextOf } from '../context-providers/conversation'
import type { AssistFailure, AssistMember } from './assist'

export const TRANSLATE_PROMPT_VERSION = 'translate.v1'
export const DRAFT_MAX_CHARS = 4000
export const translationSchema = z.object({ translation: z.string().min(1).max(8000) })

export interface TranslationResult {
  ok: true
  text: string
  /** The team language (incoming) or null (outgoing: the customer's language). */
  language: TranslationLanguage | null
  guardFlags: string[]
}

const fail = (reason: AssistFailure['reason'], guardFlags: string[] = []): AssistFailure => ({ ok: false, reason, guardFlags })

export function incomingPrompt(language: string): string {
  return [
    `Translate the customer's messages into ${language} for the business's staff.`,
    'Keep the meaning, names, numbers, prices, dates and line breaks. Do not answer the customer and do not add notes.',
    `If the text is already in ${language}, return it unchanged.`,
    'Reply with a JSON object: {"translation": "<the translated text>"}.',
  ].join('\n')
}

export function outgoingPrompt(): string {
  return [
    'Translate the staff reply into the language the customer writes in (the customer message is given only to tell its language).',
    'Keep the meaning, tone, names, numbers, prices, dates, links and line breaks. Do not add or remove information.',
    'If the customer writes in the same language as the reply, return the reply unchanged.',
    'Reply with a JSON object: {"translation": "<the translated reply>"}.',
  ].join('\n')
}

/** The customer's latest messages in the team language. */
export async function translateIncoming(member: AssistMember, conversationId: string): Promise<TranslationResult | AssistFailure> {
  const transcript = await loadTranscript({
    accountId: member.accountId, userId: member.userId, role: member.role, audience: 'staff', conversationId,
    maxMessages: featureBudget('translate').contextMessages,
  })
  if (!transcript) return fail('not_found')
  const text = recentCustomerTextOf(transcript)
  if (!text.trim()) return fail('no_messages')
  const prep = await withTenant(member, async (tx) => ({
    availability: await isAiFeatureAvailable(tx, member, 'translate'),
    language: (await readAiSettings(tx, member.accountId)).translation_language,
  }))
  if (!prep.availability.ok) return fail(prep.availability.reason)
  const result = await runAiTask({
    accountId: member.accountId, userId: member.userId, role: member.role, feature: 'translate',
    promptVersion: TRANSLATE_PROMPT_VERSION, system: incomingPrompt(TRANSLATION_LANGUAGE_NAMES[prep.language]),
    schema: translationSchema, audience: 'staff', conversationId,
    untrusted: [{ source: 'customer', text, label: 'customer messages to translate' }],
  })
  if (!result.ok) return fail(result.reason, result.guardFlags)
  return { ok: true, text: (result.value as z.infer<typeof translationSchema>).translation.trim(), language: prep.language, guardFlags: result.guardFlags }
}

/** The member's draft in the customer's language (customer-facing: guarded). */
export async function translateDraft(member: AssistMember, conversationId: string, draft: string): Promise<TranslationResult | AssistFailure> {
  const transcript = await loadTranscript({
    accountId: member.accountId, userId: member.userId, role: member.role, audience: 'customer', conversationId,
    maxMessages: featureBudget('translate').contextMessages,
  })
  if (!transcript) return fail('not_found')
  const customer = latestCustomerText(transcript)
  if (!customer.trim()) return fail('no_messages')
  const result = await runAiTask({
    accountId: member.accountId, userId: member.userId, role: member.role, feature: 'translate',
    promptVersion: TRANSLATE_PROMPT_VERSION, system: outgoingPrompt(), schema: translationSchema, audience: 'customer',
    conversationId,
    untrusted: [
      { source: 'customer', text: customer.slice(-600), label: 'customer message (for its language only)' },
      { source: 'crm', text: draft, label: 'staff reply to translate' },
    ],
    // Links the member typed may stay in the translated reply.
    allowedUrls: [...draft.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map((m) => m[0]).slice(0, 10),
  })
  if (!result.ok) return fail(result.reason, result.guardFlags)
  return { ok: true, text: (result.value as z.infer<typeof translationSchema>).translation.trim(), language: null, guardFlags: result.guardFlags }
}

/** Whether this member can translate now, and into which team language (no provider call). */
export async function translateAvailability(member: AssistMember): Promise<{ ok: boolean; reason: string | null; language: TranslationLanguage }> {
  return withTenant(member, async (tx) => {
    const availability = await isAiFeatureAvailable(tx, member, 'translate')
    const language = (await readAiSettings(tx, member.accountId)).translation_language
    return { ok: availability.ok, reason: availability.ok ? null : availability.reason, language }
  })
}
