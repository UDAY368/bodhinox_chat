import { ContractError } from './contracts';
import type { DataError } from './types';
/** Preserve stable constraint codes used by retry/deduplication consumers,
 * but never return driver messages, SQL, values, or constraint detail. */
export function dataError(error: unknown): DataError {
  if (error instanceof ContractError)
    return { message: error.message, code: error.code };
  const failure = error as {
    code?: string;
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
  };
  const orm: Record<string, string> = {
    P2002: '23505',
    P2003: '23503',
    P2004: '23514',
  };
  const candidates = [
    orm[failure?.code ?? ''],
    failure?.code,
    failure?.meta?.code,
    failure?.meta?.driverAdapterError?.cause?.originalCode,
  ];
  const messages: Record<string, string> = {
    '23505': 'Duplicate record (23505)',
    '23503': 'Related record is unavailable in this organization',
    '23514': 'Record violates a validation constraint',
    '23502': 'A required field is missing',
    '42501': 'Insufficient record permission',
    '22P02': 'Invalid field value',
    '22003': 'Numeric value is out of range',
    '40001': 'Concurrent transaction conflict; retry the operation',
    '40P01': 'Concurrent transaction conflict; retry the operation',
  };
  const code = candidates.find((code) => code && Object.hasOwn(messages, code));
  return code
    ? { code, message: messages[code] }
    : { code: 'DATABASE_ERROR', message: 'Database operation failed' };
}
