/**
 * Per-template status history (template_status_events).
 *
 * Every place that changes a template's status — draft save, submit,
 * edit, sync and Meta's webhook — calls `recordTemplateEvents` after its
 * own write lands. An event is only inserted when the status, reason or
 * quality score differs from the template's latest recorded event, so a
 * re-saved draft or a repeated sync doesn't pad the timeline.
 *
 * The table is not a browser resource; the history is read through
 * GET /api/whatsapp/templates/[id]/events, which calls
 * `listTemplateEvents`. Both run inside withTenant, so FORCE RLS scopes
 * reads to the account and limits writes to admins and the worker.
 *
 * Recording is best-effort: the template change it describes has
 * already been committed (and, for submit/edit, sent to Meta), so a
 * failed history insert is logged — without template content — and
 * swallowed rather than turning a successful operation into an error.
 */

import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant, type TenantContext } from '@/lib/db/tenant'

export type TemplateEventSource = 'draft' | 'submit' | 'webhook' | 'sync' | 'edit'

export interface TemplateStatusEventInput {
  templateId: string
  status: string
  source: TemplateEventSource
  /** Reasons belong to one status; absent means none (null). */
  reason?: string | null
  /** Absent keeps the latest recorded score; null records "no score". */
  qualityScore?: string | null
}

export interface TemplateStatusEvent {
  id: string
  status: string
  reason: string | null
  quality_score: string | null
  source: TemplateEventSource
  created_at: string
}

/** Newest-first page size for the history endpoint. */
export const TEMPLATE_EVENTS_LIMIT = 200
/** Reasons come from Meta or a submit error; keep the row bounded. */
const REASON_MAX_LENGTH = 1000

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function clip(value: string | null | undefined): string | null {
  if (value == null || value === '') return null
  return value.length > REASON_MAX_LENGTH ? value.slice(0, REASON_MAX_LENGTH) : value
}

/** Templates per transaction: bounds its runtime and what one failure loses. */
export const TEMPLATE_EVENTS_CHUNK = 50

/**
 * The rejection reason to store and record for a template in `status`.
 * Meta sends 'NONE' (or nothing) when there is no reason, and reasons
 * only belong to REJECTED. The webhook and the sync both use this, so
 * the same Meta state always stores the same value and a later sync
 * does not look like a change. A generic label for a reason-less
 * rejection is a display concern, not stored data.
 */
export function normalizeRejectionReason(
  status: string,
  raw: unknown,
): string | null {
  if (status !== 'REJECTED' || typeof raw !== 'string') return null
  const reason = raw.trim()
  return reason && reason.toUpperCase() !== 'NONE' ? reason : null
}

type LatestEvent = { status: string; reason: string | null; quality_score: string | null }

/**
 * Insert one event per input whose state differs from that template's
 * latest event. `worker` selects the worker connection (webhook jobs);
 * request handlers use the app role with the caller's session context.
 * Inputs are recorded in chunks of TEMPLATE_EVENTS_CHUNK, each in its
 * own transaction with one latest-event read and one insert, so a
 * whole-catalog sync stays well inside the transaction timeout and a
 * failed chunk loses only its own events. Inputs for templates that no
 * longer exist in the account are skipped. Returns how many rows were
 * inserted.
 */
export async function recordTemplateEvents(
  context: TenantContext,
  events: TemplateStatusEventInput[],
  opts: { worker?: boolean } = {},
): Promise<number> {
  const valid = events.filter((e) => UUID_RE.test(e.templateId) && e.status)
  if (valid.length === 0 || !UUID_RE.test(context.accountId)) return 0
  let inserted = 0
  for (let i = 0; i < valid.length; i += TEMPLATE_EVENTS_CHUNK) {
    inserted += await recordChunk(context, valid.slice(i, i + TEMPLATE_EVENTS_CHUNK), opts)
  }
  return inserted
}

async function recordChunk(
  context: TenantContext,
  chunk: TemplateStatusEventInput[],
  opts: { worker?: boolean },
): Promise<number> {
  const ids = [...new Set(chunk.map((e) => e.templateId))]
  try {
    return await withTenant(
      context,
      async (tx) => {
        const present = await tx.message_templates.findMany({
          where: { account_id: context.accountId, id: { in: ids } },
          select: { id: true },
        })
        const existing = new Set(present.map((t) => t.id))
        if (existing.size === 0) return 0
        const rows = await tx.$queryRaw<(LatestEvent & { template_id: string })[]>`
          SELECT DISTINCT ON (template_id) template_id::text AS template_id, status, reason, quality_score
          FROM template_status_events
          WHERE account_id = ${context.accountId}::uuid
            AND template_id = ANY(${[...existing]}::uuid[])
          ORDER BY template_id, created_at DESC, id DESC`
        const latest = new Map<string, LatestEvent>(rows.map((r) => [r.template_id, r]))
        const data: {
          account_id: string
          template_id: string
          status: string
          reason: string | null
          quality_score: string | null
          source: string
        }[] = []
        for (const event of chunk) {
          if (!existing.has(event.templateId)) continue
          const prev = latest.get(event.templateId)
          const reason = clip(event.reason)
          const quality =
            event.qualityScore === undefined
              ? (prev?.quality_score ?? null)
              : event.qualityScore
          if (
            prev &&
            prev.status === event.status &&
            prev.reason === reason &&
            prev.quality_score === quality
          ) {
            continue
          }
          const next = { status: event.status, reason, quality_score: quality }
          latest.set(event.templateId, next)
          data.push({
            account_id: context.accountId,
            template_id: event.templateId,
            ...next,
            source: event.source,
          })
        }
        if (data.length === 0) return 0
        const { count } = await tx.template_status_events.createMany({ data })
        return count
      },
      opts.worker ? getWorkerPrisma() : getPrisma(),
    )
  } catch (err) {
    console.error(
      '[template-events] failed to record status history',
      err instanceof Error ? err.name : 'unknown',
    )
    return 0
  }
}

/** One template's history, newest first, as the caller's tenant sees it. */
export async function listTemplateEvents(
  context: TenantContext,
  templateId: string,
): Promise<TemplateStatusEvent[]> {
  const rows = await withTenant(context, (tx) =>
    tx.template_status_events.findMany({
      where: { account_id: context.accountId, template_id: templateId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: TEMPLATE_EVENTS_LIMIT,
      select: {
        id: true,
        status: true,
        reason: true,
        quality_score: true,
        source: true,
        created_at: true,
      },
    }),
  )
  return rows.map((r) => ({
    ...r,
    source: r.source as TemplateEventSource,
    created_at: r.created_at.toISOString(),
  }))
}
