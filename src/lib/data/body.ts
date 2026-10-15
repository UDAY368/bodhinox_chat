import { ContractError } from './contracts';
export async function readJsonBody(
  request: Request,
  maxBytes = 1048576
): Promise<unknown> {
  if (
    !(request.headers.get('content-type') ?? '')
      .toLowerCase()
      .startsWith('application/json')
  )
    throw new ContractError(
      'Expected application/json',
      'UNSUPPORTED_MEDIA_TYPE',
      415
    );
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes)
    throw new ContractError('Request body too large', 'BODY_TOO_LARGE', 413);
  if (!request.body) throw new ContractError('Missing JSON payload');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ContractError(
          'Request body too large',
          'BODY_TOO_LARGE',
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ContractError('Invalid JSON payload');
  }
}
