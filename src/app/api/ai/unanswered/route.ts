import { NextResponse } from 'next/server'
import { getT } from '@/lib/i18n/translate'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { listUnanswered, UnansweredError, type UnansweredStatus } from '@/lib/ai/unanswered'

const t = getT('Api')

const STATUSES: readonly UnansweredStatus[] = ['open', 'answered', 'dismissed']

function intParam(value: string | null, fallback: number): number {
  if (value === null || !/^\d{1,6}$/.test(value)) return fallback
  return Number(value)
}

/**
 * GET /api/ai/unanswered?status=open|answered|dismissed&limit=25&offset=0 (agent+)
 *
 * Questions the AI agent could not answer, grouped by normalised text
 * (`occurrences` counts repeats), most recently asked first.
 */
export async function GET(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('agent')
    const params = new URL(request.url).searchParams
    const rawStatus = params.get('status') ?? 'open'
    if (!(STATUSES as readonly string[]).includes(rawStatus)) {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
    const result = await listUnanswered({ accountId, userId, role }, {
      status: rawStatus as UnansweredStatus,
      limit: Math.min(100, Math.max(1, intParam(params.get('limit'), 25))),
      offset: intParam(params.get('offset'), 0),
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof UnansweredError) return NextResponse.json({ error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
