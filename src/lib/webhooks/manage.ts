// ============================================================
// Webhook endpoint management shared by the public API
// (`/api/v1/webhooks`, API-key auth) and the dashboard
// (`/api/account/webhooks`, session auth). Callers own auth and the
// response envelope; this module owns validation and persistence.
// ============================================================

import type { DataClient } from '@/lib/data/types';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
  type ApiWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

/** Caller input was invalid; the message is safe to show (HTTP 400). */
export class WebhookInputError extends Error {}

const URL_INVALID = "'url' must be a valid https:// URL";
const EVENTS_INVALID = "'events' must be a non-empty array of known event names";

function asBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WebhookInputError('Request body must be a JSON object');
  return input as Record<string, unknown>;
}

function storeError(action: string, error: unknown): Error {
  console.error(`[webhooks] ${action} failed`, error);
  return new Error(`Failed to ${action} webhook`);
}

export async function listWebhooks(db: DataClient, accountId: string): Promise<ApiWebhookEndpoint[]> {
  const { data, error } = await db
    .from('webhook_endpoints')
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw storeError('list', error);
  return (data ?? []).map((r) => serializeWebhookEndpoint(r as Record<string, unknown>));
}

/** Returns the endpoint plus its signing secret, which is shown exactly once. */
export async function createWebhook(
  db: DataClient,
  accountId: string,
  createdBy: string | null,
  input: unknown
): Promise<ApiWebhookEndpoint & { secret: string }> {
  const body = asBody(input);
  const url = normalizeWebhookUrl(body.url);
  if (!url) throw new WebhookInputError(URL_INVALID);
  const events = normalizeEvents(body.events);
  if (!events) throw new WebhookInputError(EVENTS_INVALID);
  const secret = generateWebhookSecret();
  const { data, error } = await db
    .from('webhook_endpoints')
    .insert({ account_id: accountId, created_by: createdBy, url, secret: encrypt(secret), events })
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .single();
  if (error || !data) throw storeError('create', error);
  return { ...serializeWebhookEndpoint(data as Record<string, unknown>), secret };
}

/** Returns null when the id is not an endpoint of this account. */
export async function updateWebhook(
  db: DataClient,
  accountId: string,
  id: string,
  input: unknown
): Promise<ApiWebhookEndpoint | null> {
  const body = asBody(input);
  const updates: Record<string, unknown> = {};
  if ('url' in body) {
    const url = normalizeWebhookUrl(body.url);
    if (!url) throw new WebhookInputError(URL_INVALID);
    updates.url = url;
  }
  if ('events' in body) {
    const events = normalizeEvents(body.events);
    if (!events) throw new WebhookInputError(EVENTS_INVALID);
    updates.events = events;
  }
  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') throw new WebhookInputError("'is_active' must be a boolean");
    updates.is_active = body.is_active;
    // Re-enabling clears the failure streak so one stale failure can't re-disable it.
    if (body.is_active) updates.failure_count = 0;
  }
  if (Object.keys(updates).length === 0) throw new WebhookInputError('No updatable fields provided');
  const { data, error } = await db
    .from('webhook_endpoints')
    .update(updates)
    .eq('id', id)
    .eq('account_id', accountId)
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw storeError('update', error);
  return data ? serializeWebhookEndpoint(data as Record<string, unknown>) : null;
}

/** Returns false when the id is not an endpoint of this account. */
export async function deleteWebhook(db: DataClient, accountId: string, id: string): Promise<boolean> {
  const { data, error } = await db
    .from('webhook_endpoints')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id')
    .maybeSingle();
  if (error) throw storeError('delete', error);
  return Boolean(data);
}
