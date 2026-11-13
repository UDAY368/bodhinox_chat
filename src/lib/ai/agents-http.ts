import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { AgentProfileError } from './agent-profile'
import { AgentError } from './agents'

const t = getT('AiStudio.agents.errors')

/** Refusals carry a stable `code` and a translated `error`; anything unexpected goes through toErrorResponse. */
export function agentErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentError) return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status })
  if (error instanceof AgentProfileError) return NextResponse.json({ error: error.message, code: 'invalid_input' }, { status: error.status })
  return toErrorResponse(error)
}

export const NO_STORE = { 'Cache-Control': 'private, no-store' }
