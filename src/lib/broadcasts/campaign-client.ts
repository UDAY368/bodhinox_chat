// Browser calls for the campaign actions added with the Campaigns redesign:
// Instagram broadcasts (estimate, create) and pause / resume / send now.
// Every route checks the session, role and campaigns.send on the server.
import { authFetch } from '@/lib/auth/client';
import type { AudienceConfig } from '@/lib/broadcast-audience';

export interface InstagramAudienceCount {
  onInstagram: number;
  eligible: number;
}

/** Only the audience fields the server accepts; wizard-only fields (csvText) never travel. */
function audienceBody(audience: AudienceConfig) {
  return {
    type: audience.type,
    tagIds: audience.tagIds,
    customField: audience.customField,
    excludeTagIds: audience.excludeTagIds,
    segmentId: audience.segmentId,
    listId: audience.listId,
  };
}

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await authFetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || fallback);
  return payload as T;
}

export function estimateInstagramAudience(audience: AudienceConfig): Promise<InstagramAudienceCount> {
  return call('/api/broadcasts/instagram/estimate', { method: 'POST', body: JSON.stringify({ audience: audienceBody(audience) }) },
    'Could not count the audience');
}

export async function createInstagramCampaign(input: { name: string; text: string; audience: AudienceConfig }): Promise<string> {
  const result = await call<{ id?: unknown }>('/api/broadcasts/instagram', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, text: input.text, audience: audienceBody(input.audience) }),
  }, 'Could not create the campaign');
  if (typeof result.id !== 'string') throw new Error('Campaign creation returned no identifier');
  return result.id;
}

export function pauseCampaign(id: string): Promise<unknown> {
  return call(`/api/broadcasts/${encodeURIComponent(id)}/pause`, { method: 'POST', body: '{}' }, 'Could not pause the campaign');
}

/** Resume a paused or stalled campaign (pending), or retry its failed recipients. */
export function resumeCampaign(id: string, scope: 'pending' | 'failed'): Promise<{ resuming?: number; remaining?: number }> {
  return call(`/api/whatsapp/broadcast/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ scope }) },
    'Could not resume the campaign');
}

/** Start a scheduled campaign now instead of at its time. */
export function sendScheduledNow(id: string): Promise<unknown> {
  return call(`/api/broadcasts/${encodeURIComponent(id)}/schedule`, { method: 'PATCH', body: JSON.stringify({ sendNow: true }) },
    'Could not start the campaign');
}

/** Cancel a scheduled campaign before it starts. */
export function cancelSchedule(id: string): Promise<unknown> {
  return call(`/api/broadcasts/${encodeURIComponent(id)}/schedule`, { method: 'DELETE' }, 'Could not cancel the schedule');
}
