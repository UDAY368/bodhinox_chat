// Text extraction for knowledge-base uploads: PDF (unpdf, a serverless build
// of pdf.js), DOCX (mammoth) and plain text / Markdown.
//
// The type is decided from the file's leading bytes, not only its name or
// declared type. PDF and DOCX parsing runs in a worker thread
// (file-extract-worker.ts) with a capped heap, an allocation budget for
// typed-array and decompression memory, a real cap on DOCX inflation and a
// wall-clock timeout, so a decompression bomb or a slow parse is refused
// instead of taking down the web process. Extracted text is customer content
// and is never logged.
import { Worker } from 'node:worker_threads'
import type { ExtractJob, ExtractReply } from './file-extract-worker'

export const FILE_MAX_BYTES = 10 * 1024 * 1024
export const PDF_MAX_PAGES = 300
export const FILE_TEXT_MAX_CHARS = 300_000
/** Real bytes a DOCX may inflate to, across every part mammoth reads. */
export const DOCX_MAX_UNPACKED_BYTES = 60 * 1024 * 1024

export type FileKind = 'pdf' | 'docx' | 'text'
export type FileExtractErrorCode = 'unsupported_type' | 'too_large' | 'too_many_pages' | 'unreadable' | 'empty'

export class FileExtractError extends Error {
  constructor(readonly code: FileExtractErrorCode) {
    super(`File extraction failed: ${code}`)
    this.name = 'FileExtractError'
  }
}

export interface ExtractedFile {
  kind: FileKind
  text: string
  pages: number | null
  truncated: boolean
}

/** Bounds on one PDF or DOCX extraction. Tests narrow them; callers use the defaults. */
export interface ExtractLimits {
  timeoutMs: number
  heapMb: number
  allocBudgetBytes: number
  maxUnpackedBytes: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  timeoutMs: 20_000,
  heapMb: 256,
  allocBudgetBytes: 512 * 1024 * 1024,
  maxUnpackedBytes: DOCX_MAX_UNPACKED_BYTES,
}

/** At most this many extraction workers per process; later uploads wait their turn. */
const MAX_CONCURRENT_EXTRACTIONS = 2
let activeExtractions = 0
const waitingExtractions: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (activeExtractions < MAX_CONCURRENT_EXTRACTIONS) { activeExtractions++; return }
  await new Promise<void>((resolve) => waitingExtractions.push(resolve))
}

function releaseSlot(): void {
  const next = waitingExtractions.shift()
  if (next) next() // the slot passes straight to the next waiter
  else activeExtractions--
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** PDF by its %PDF- signature, DOCX by zip signature plus name or type, text by name or type and valid UTF-8. */
export function detectFileKind(bytes: Uint8Array, name: string, contentType: string): FileKind | null {
  const lower = name.toLowerCase()
  const type = contentType.toLowerCase().split(';')[0].trim()
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  if (head.includes('%PDF-')) return 'pdf'
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (zip) return lower.endsWith('.docx') || type === DOCX_TYPE ? 'docx' : null
  if (/\.(txt|md|markdown|csv)$/.test(lower) || type === 'text/plain' || type === 'text/markdown' || type === 'text/csv') {
    return bytes.includes(0) ? null : 'text'
  }
  return null
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Runs one PDF or DOCX parse in a fresh worker and kills it on overrun. */
function runInWorker(kind: 'pdf' | 'docx', bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractReply> {
  return new Promise((resolve) => {
    const copy = new Uint8Array(bytes) // transferred, so the caller's buffer stays intact
    const job: ExtractJob = {
      kind,
      bytes: copy,
      maxPages: PDF_MAX_PAGES,
      maxUnpackedBytes: limits.maxUnpackedBytes,
      allocBudgetBytes: limits.allocBudgetBytes,
      // Normalization only shrinks text, so this leaves room before the final cap.
      maxRawChars: FILE_TEXT_MAX_CHARS * 4,
    }
    let settled = false
    let worker: Worker | null = null
    const finish = (reply: ExtractReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker?.terminate().catch(() => {})
      resolve(reply)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'too_large' }), limits.timeoutMs)
    try {
      // The literal new URL(..., import.meta.url) form lets the bundler emit the worker as its own entry.
      worker = new Worker(new URL('./file-extract-worker.ts', import.meta.url), {
        workerData: { fileExtractJob: job },
        transferList: [copy.buffer as ArrayBuffer],
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      })
    } catch (err) {
      console.error('[file-extract] could not start the extraction worker', (err as { code?: string }).code ?? 'unknown')
      finish({ ok: false, code: 'unreadable' })
      return
    }
    worker.once('message', (reply: ExtractReply) => finish(reply))
    worker.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') return finish({ ok: false, code: 'too_large' })
      // Only the error code: messages from a parser may quote the document.
      console.error('[file-extract] extraction worker failed', err.code ?? err.name)
      finish({ ok: false, code: 'unreadable' })
    })
    worker.once('exit', () => finish({ ok: false, code: 'unreadable' }))
  })
}

/** Extracts readable text from an uploaded file, or throws FileExtractError. */
export async function extractFileText(
  bytes: Uint8Array,
  meta: { name: string; contentType: string },
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ExtractedFile> {
  if (bytes.byteLength === 0) throw new FileExtractError('empty')
  if (bytes.byteLength > FILE_MAX_BYTES) throw new FileExtractError('too_large')
  const kind = detectFileKind(bytes, meta.name, meta.contentType)
  if (!kind) throw new FileExtractError('unsupported_type')

  let raw: string
  let pages: number | null = null
  let rawTruncated = false
  if (kind === 'text') {
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new FileExtractError('unreadable') }
  } else {
    await acquireSlot()
    let reply: ExtractReply
    try { reply = await runInWorker(kind, bytes, limits) } finally { releaseSlot() }
    if (!reply.ok) throw new FileExtractError(reply.code)
    raw = reply.text
    pages = reply.pages
    rawTruncated = reply.truncated
  }

  const text = normalizeExtractedText(raw)
  if (!text) throw new FileExtractError('empty')
  const truncated = rawTruncated || text.length > FILE_TEXT_MAX_CHARS
  return { kind, text: text.length > FILE_TEXT_MAX_CHARS ? text.slice(0, FILE_TEXT_MAX_CHARS) : text, pages, truncated }
}
