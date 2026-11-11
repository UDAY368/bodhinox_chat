'use client';

// Sequences (Stage 5, 5H): the browser side of /api/sequences. Every call goes
// through authFetch (session cookie plus the CSRF header on mutations); the
// server checks the role and the workspace. Errors come back as the server's
// code so the page can show Instagram.sequences.errors.<code>.

import { authFetch } from '@/lib/auth/client';
import type { SequenceDetail, SequenceSubscriber, SequenceSummary } from '@/lib/sequences/store';

export type { SequenceDetail, SequenceMessageView, SequenceSubscriber, SequenceSummary } from '@/lib/sequences/store';

export const SEQUENCE_ERROR_CODES = [
  'invalid_request', 'notFound', 'tooManyMessages', 'flowNotFound', 'busy', 'forbidden', 'instagram_not_enabled',
] as const;
export type SequenceClientError = (typeof SEQUENCE_ERROR_CODES)[number] | 'generic';

export class SequenceRequestError extends Error {
  constructor(readonly code: SequenceClientError) {
    super(code);
    this.name = 'SequenceRequestError';
  }
}

/** The i18n key under Instagram.sequences.errors for any thrown value. */
export function sequenceErrorKey(error: unknown): SequenceClientError {
  return error instanceof SequenceRequestError ? error.code : 'generic';
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, {
    cache: 'no-store',
    ...init,
    headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  const json = (await res.json().catch(() => ({}))) as { code?: unknown } & T;
  if (!res.ok) {
    const code = typeof json.code === 'string' && (SEQUENCE_ERROR_CODES as readonly string[]).includes(json.code)
      ? (json.code as SequenceClientError) : 'generic';
    throw new SequenceRequestError(code);
  }
  return json;
}

const base = (id: string) => `/api/sequences/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const sequenceApi = {
  list: async () => (await call<{ sequences: SequenceSummary[] }>('/api/sequences')).sequences,
  create: async (name: string) => (await call<{ sequence: SequenceDetail }>('/api/sequences', json('POST', { name }))).sequence,
  get: async (id: string) => (await call<{ sequence: SequenceDetail }>(base(id))).sequence,
  update: async (id: string, patch: { name?: string; status?: 'active' | 'paused' }) =>
    (await call<{ sequence: SequenceDetail }>(base(id), json('PATCH', patch))).sequence,
  archive: async (id: string) => { await call<unknown>(base(id), { method: 'DELETE' }); },
  addExisting: async (id: string, flowId: string) =>
    (await call<{ sequence: SequenceDetail }>(`${base(id)}/messages`, json('POST', { flow_id: flowId }))).sequence,
  addNew: async (id: string, name: string) =>
    (await call<{ sequence: SequenceDetail }>(`${base(id)}/messages`, json('POST', { create: { name } }))).sequence,
  reorder: async (id: string, order: string[]) =>
    (await call<{ sequence: SequenceDetail }>(`${base(id)}/messages`, json('PUT', { order }))).sequence,
  updateMessage: async (id: string, messageId: string,
    patch: { delay_amount?: number; delay_unit?: string; active?: boolean; flow_id?: string }) =>
    (await call<{ sequence: SequenceDetail }>(`${base(id)}/messages/${encodeURIComponent(messageId)}`, json('PATCH', patch))).sequence,
  removeMessage: async (id: string, messageId: string) =>
    (await call<{ sequence: SequenceDetail }>(`${base(id)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' })).sequence,
  subscribers: async (id: string) => (await call<{ subscribers: SequenceSubscriber[] }>(`${base(id)}/subscribers`)).subscribers,
  unsubscribe: async (id: string, contactId: string) =>
    (await call<{ status: string }>(`${base(id)}/subscribers`, json('POST', { action: 'unsubscribe', contact_id: contactId }))).status,
};
