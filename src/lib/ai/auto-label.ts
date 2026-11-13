// Auto-labelling (Assistant features): the 'ai.auto_label' job adds up to two
// of the workspace's own conversation labels to a NEW conversation, from its
// first customer messages.
//
// Queued by the inbound 'ai_label' stage for typed customer text, once per
// conversation (dedupe key), run two minutes later so a split first message
// is read whole. The job does nothing when the conversation already has a
// label (a person labelled it first), when the workspace has no labels, or
// when the feature is unavailable: runAiTask checks the deployment switch, the
// workspace switch, a configured key and the monthly token budget (including
// the workspace cap while "pause when the budget is used up" is on) before any
// provider call, and meters the call. The model only picks names from the
// list; anything else is dropped. Nothing is sent to the customer. Customer
// text is never logged.

import { z } from 'zod'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'
import { enqueueJob } from '@/lib/jobs/queue'
import { aiDeploymentEnabled } from './gate'
import { logAiEvent } from './log'
import { readAiSettings } from './settings'
import { runAiTask } from './task'

export const AI_LABEL_JOB = 'ai.auto_label'
export const LABEL_PROMPT_VERSION = 'label.v1'
/** Delay before labelling, so a first message split over several bubbles is read whole. */
export const LABEL_DELAY_MS = 2 * 60_000
export const MAX_AUTO_LABELS = 2
const MESSAGES = 6
const MESSAGE_CHARS = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const labelOutputSchema = z.object({ labels: z.array(z.string().max(80)).max(5) })

export function labelSystemPrompt(names: readonly string[]): string {
  return [
    'Choose the labels that describe what the customer wants in the messages below.',
    `Allowed labels (use the exact names): ${JSON.stringify(names)}.`,
    `Pick at most ${MAX_AUTO_LABELS}. Pick none when no label clearly fits.`,
    'Reply with a JSON object: {"labels": ["<name>", ...]}.',
  ].join('\n')
}

/** The label ids for the model's names: exact names (case-insensitive) from the list, at most MAX_AUTO_LABELS. */
export function matchLabels(picked: readonly string[], labels: readonly { id: string; name: string }[]): string[] {
  const byName = new Map(labels.map((l) => [l.name.trim().toLowerCase(), l.id]))
  const ids: string[] = []
  for (const name of picked) {
    const id = byName.get(String(name).trim().toLowerCase())
    if (id && !ids.includes(id)) ids.push(id)
    if (ids.length >= MAX_AUTO_LABELS) break
  }
  return ids
}

/** Queues the conversation's one labelling job; never throws (logged as a reason code). */
export async function enqueueAutoLabelForInbound(accountId: string, conversationId: string, now: number = Date.now()): Promise<boolean> {
  if (!aiDeploymentEnabled()) return false
  try {
    const settings = await withTenant({ accountId, role: 'owner' }, (tx) => readAiSettings(tx, accountId), getWorkerPrisma())
    if (!settings.labelling_enabled) return false
    await enqueueJob(AI_LABEL_JOB, { conversationId }, {
      tenantId: accountId, dedupeKey: `ai-label:${conversationId}`, runAt: new Date(now + LABEL_DELAY_MS), maxAttempts: 3,
    })
    return true
  } catch (error) {
    logAiEvent({ feature: 'label', reason: 'enqueue_failed', accountId, error })
    return false
  }
}

/** The 'ai.auto_label' job. Gate, toggle and budget reasons end it normally; database errors retry. */
export async function handleAutoLabelJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const conversationId = payload.conversationId
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw new Error('Invalid auto-label payload')
  const prisma = getWorkerPrisma()
  const input = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const settings = await readAiSettings(tx, accountId)
    if (!settings.labelling_enabled) return null
    const [labelled] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM conversation_label_links
      WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid`
    if (labelled && labelled.n > 0) return null
    const labels = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM conversation_labels
      WHERE account_id=${accountId}::uuid ORDER BY name LIMIT 40`
    if (!labels.length) return null
    const messages = await tx.$queryRaw<{ content_text: string }[]>`SELECT content_text FROM messages
      WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid AND sender_type='customer'
        AND content_text IS NOT NULL AND btrim(content_text) <> ''
      ORDER BY created_at, id LIMIT ${MESSAGES}`
    if (!messages.length) return null
    return { labels, text: messages.map((m) => m.content_text.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)).join('\n') }
  }, prisma)
  if (!input) return

  const result = await runAiTask({
    accountId, userId: null, role: 'owner', feature: 'label', promptVersion: LABEL_PROMPT_VERSION,
    system: labelSystemPrompt(input.labels.map((l) => l.name)), schema: labelOutputSchema, audience: 'staff',
    untrusted: [{ source: 'customer', text: input.text, label: 'customer messages' }], conversationId,
    sourceKey: `label:${conversationId}`, db: prisma,
  })
  if (!result.ok) return
  const ids = matchLabels((result.value as z.infer<typeof labelOutputSchema>).labels, input.labels)
  if (!ids.length) return
  await withTenant({ accountId, role: 'owner' }, async (tx) => {
    // A person may have labelled it while the model ran: theirs wins.
    const [labelled] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM conversation_label_links
      WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid`
    if (labelled && labelled.n > 0) return
    for (const id of ids) {
      await tx.$executeRaw`INSERT INTO conversation_label_links(account_id, conversation_id, label_id)
        SELECT ${accountId}::uuid, c.id, l.id FROM conversations c, conversation_labels l
        WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid AND l.account_id=${accountId}::uuid AND l.id=${id}::uuid
        ON CONFLICT DO NOTHING`
    }
  }, prisma)
  logAiEvent({ feature: 'label', reason: 'labelled', accountId })
}
