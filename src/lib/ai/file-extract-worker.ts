// Runs one PDF or DOCX extraction inside a worker thread started by
// file-extract.ts, so a hostile upload cannot exhaust the web process.
//
// The worker's V8 heap is capped by resourceLimits, but typed-array and
// ArrayBuffer memory lives outside that heap. This file therefore also
// charges every typed-array allocation and every DecompressionStream chunk
// against a byte budget, and inflates DOCX parts itself with a real output
// cap instead of trusting the sizes an attacker wrote into the zip.
//
// Keep this file self-contained (packages and node: builtins only, no relative
// imports): it is a worker entry point for the bundler and, under vitest, runs
// directly in Node with type stripping. Types only, no enums or parameter
// properties. Extracted text is customer content and is never logged.
import { parentPort, workerData } from 'node:worker_threads'
import { inflateRawSync } from 'node:zlib'

export interface ExtractJob {
  kind: 'pdf' | 'docx'
  bytes: Uint8Array
  maxPages: number
  /** Real (inflated) bytes a DOCX may unpack to, across every part read. */
  maxUnpackedBytes: number
  /** Typed-array and decompression bytes the worker may allocate in total. */
  allocBudgetBytes: number
  /** Raw text characters returned before the caller normalizes and caps it. */
  maxRawChars: number
}

export type ExtractRefusal = 'too_large' | 'too_many_pages' | 'unreadable'
export type ExtractReply =
  | { ok: true; text: string; pages: number | null; truncated: boolean }
  | { ok: false; code: ExtractRefusal }

class Refused extends Error {
  code: ExtractRefusal
  constructor(code: ExtractRefusal) {
    super(code)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Allocation budget

const TYPED_ARRAYS = [
  'ArrayBuffer', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
] as const

export interface AllocationBudget {
  exceeded(): boolean
}

/**
 * Wraps the global typed-array constructors and DecompressionStream so every
 * allocation is charged against `limit` bytes. Once the budget is spent every
 * later charge throws as well, so a library that swallows one error and
 * retries another way is still stopped. Only for a worker: it changes globals.
 */
export function installAllocationBudget(limit: number): AllocationBudget {
  let used = 0
  const charge = (bytes: number) => {
    if (!(bytes > 0)) return
    used += bytes
    if (used > limit) throw new RangeError('allocation budget exceeded')
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const NativeArrayBuffer = ArrayBuffer
  const NativeShared = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null

  for (const name of TYPED_ARRAYS) {
    const Native = globals[name] as (new (...args: unknown[]) => object) & { BYTES_PER_ELEMENT?: number }
    const unit = Native.BYTES_PER_ELEMENT ?? 1
    globals[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        const first = args[0]
        if (typeof first === 'number') charge(first * unit)
        else if (first && typeof first === 'object' && !(first instanceof NativeArrayBuffer) && !(NativeShared && first instanceof NativeShared)) {
          const length = (first as { length?: unknown }).length
          if (typeof length === 'number') charge(length * unit)
        }
        return Reflect.construct(target, args, newTarget) as object
      },
    })
  }

  const NativeDecompression = globals.DecompressionStream as (new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) | undefined
  if (NativeDecompression) {
    const Inner = NativeDecompression
    globals.DecompressionStream = class BudgetedDecompressionStream {
      readable: ReadableStream<Uint8Array>
      writable: WritableStream<Uint8Array>
      constructor(format: string) {
        const inner = new Inner(format)
        this.writable = inner.writable
        // Backpressure through the pipe stops zlib once the budget errors the stream.
        this.readable = inner.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            charge(chunk.byteLength)
            controller.enqueue(chunk)
          },
        }))
      }
    }
  }

  return { exceeded: () => used > limit }
}

// ---------------------------------------------------------------------------
// DOCX: a zip read from its central directory, parts inflated on demand

export interface DocxZip {
  exists(name: string): boolean
  read(name: string, encoding?: string): Promise<Uint8Array | string>
  write(name: string, contents: unknown): void
  toArrayBuffer(): Promise<ArrayBuffer>
  overCap(): boolean
}

const MAX_ZIP_ENTRIES = 5000

/**
 * Indexes a zip for mammoth without inflating anything. Each part is
 * inflated only when read, through zlib's maxOutputLength, against one shared
 * cap of real output bytes. The uncompressed sizes in the archive are ignored.
 */
export function openDocxZip(input: Uint8Array, maxUnpackedBytes: number): DocxZip {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Refused('unreadable')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Refused('unreadable') // zip64 is not used by DOCX
  if (count > MAX_ZIP_ENTRIES) throw new Refused('too_large')

  const parts = new Map<string, { method: number; data: Buffer }>()
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Refused('unreadable')
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressed = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const local = buf.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd > buf.length) throw new Refused('unreadable')
    const name = buf.toString('utf8', offset + 46, nameEnd)
    offset = nameEnd + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32)

    if (name.endsWith('/') || parts.has(name)) continue
    if (flags & 0x1) throw new Refused('unreadable') // encrypted
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Refused('unreadable')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compressed > buf.length) throw new Refused('unreadable')
    parts.set(name, { method, data: buf.subarray(start, start + compressed) })
  }

  let unpacked = 0
  let over = false
  const inflate = (name: string): Buffer => {
    const part = parts.get(name)
    if (!part) throw new Refused('unreadable')
    const remaining = maxUnpackedBytes - unpacked
    let out: Buffer
    if (part.method === 0) out = part.data
    else if (part.method === 8) {
      try {
        out = inflateRawSync(part.data, { maxOutputLength: Math.max(1, remaining) })
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') { over = true; throw new Refused('too_large') }
        throw new Refused('unreadable')
      }
    } else throw new Refused('unreadable')
    if (out.length > remaining) { over = true; throw new Refused('too_large') }
    unpacked += out.length
    return out
  }

  return {
    exists: (name) => parts.has(name),
    read: async (name, encoding) => {
      const data = inflate(name)
      if (encoding === 'base64') return data.toString('base64')
      if (encoding) return new TextDecoder(encoding).decode(data)
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    },
    write: () => { throw new Refused('unreadable') },
    toArrayBuffer: async () => { throw new Refused('unreadable') },
    overCap: () => over,
  }
}

// ---------------------------------------------------------------------------
// Extraction

async function pdfText(bytes: Uint8Array, maxPages: number): Promise<{ text: string; pages: number }> {
  const { getDocumentProxy, extractText } = await import('unpdf')
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(bytes, { disableFontFace: true, verbosity: 0 })
  } catch {
    throw new Refused('unreadable')
  }
  try {
    if (pdf.numPages > maxPages) throw new Refused('too_many_pages')
    const { text } = await extractText(pdf, { mergePages: false })
    return { text: text.join('\n\n'), pages: pdf.numPages }
  } finally {
    await pdf.loadingTask.destroy().catch(() => {})
  }
}

type RawTextExtractor = { extractRawText(input: { file: DocxZip }): Promise<{ value: string }> }

async function docxText(bytes: Uint8Array, maxUnpackedBytes: number): Promise<string> {
  const zip = openDocxZip(bytes, maxUnpackedBytes)
  const loaded = (await import('mammoth')) as unknown as RawTextExtractor & { default?: RawTextExtractor }
  const mammoth = loaded.default ?? loaded
  try {
    return (await mammoth.extractRawText({ file: zip })).value
  } catch (err) {
    if (zip.overCap()) throw new Refused('too_large')
    throw err
  }
}

export async function runExtractJob(job: ExtractJob, budget: AllocationBudget | null): Promise<ExtractReply> {
  try {
    const { text, pages } = job.kind === 'pdf'
      ? await pdfText(job.bytes, job.maxPages)
      : { text: await docxText(job.bytes, job.maxUnpackedBytes), pages: null }
    // A library may swallow the budget error and return partial text; refuse it anyway.
    if (budget?.exceeded()) return { ok: false, code: 'too_large' }
    const truncated = text.length > job.maxRawChars
    return { ok: true, text: truncated ? text.slice(0, job.maxRawChars) : text, pages, truncated }
  } catch (err) {
    if (budget?.exceeded()) return { ok: false, code: 'too_large' }
    if (err instanceof Refused) return { ok: false, code: err.code }
    return { ok: false, code: 'unreadable' }
  }
}

const job = (workerData as { fileExtractJob?: ExtractJob } | null)?.fileExtractJob
if (parentPort && job) {
  const port = parentPort
  // Libraries print warnings that can quote document content; nothing here may log.
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[level] = () => {}
  const budget = installAllocationBudget(job.allocBudgetBytes)
  void runExtractJob(job, budget).then((reply) => port.postMessage(reply))
}
