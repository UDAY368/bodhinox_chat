export class BodyTooLargeError extends Error { readonly status = 413; constructor() { super('Request body exceeds the allowed size') } }
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length')) > limit) throw new BodyTooLargeError()
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > limit) { await reader.cancel(); throw new BodyTooLargeError() }
    chunks.push(next.value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
