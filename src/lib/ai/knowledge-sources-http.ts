import { NextResponse } from 'next/server'
import { BodyTooLargeError } from '@/lib/api/bounded-body'
import { toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { FileExtractError } from './file-extract'
import { KnowledgeSourceError } from './knowledge-sources'

const t = getT('AiKnowledgeSources.errors')

const FILE_STATUS: Record<FileExtractError['code'], number> = {
  unsupported_type: 415, too_large: 413, too_many_pages: 413, unreadable: 422, empty: 422,
}

/** Refusals carry a stable `code` and a translated `error`; anything unexpected is a generic 500. */
export function knowledgeSourceErrorResponse(error: unknown): NextResponse {
  if (error instanceof KnowledgeSourceError) {
    return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status })
  }
  if (error instanceof FileExtractError) {
    return NextResponse.json({ error: t(`file_${error.code}`), code: error.code }, { status: FILE_STATUS[error.code] })
  }
  if (error instanceof BodyTooLargeError) {
    return NextResponse.json({ error: t('file_too_large'), code: 'too_large' }, { status: 413 })
  }
  return toErrorResponse(error)
}
