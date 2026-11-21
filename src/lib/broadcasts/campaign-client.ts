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
    ...(audience.skipRecentDays ? { skipRecentDays: audience.skipRecentDays } : {}),
  };
}

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await authFetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = payload as { error?: string; code?: unknown };
    // The reason code (when the route gives one) lets the page show a translated message.
    throw Object.assign(new Error(body.error || fallback), { code: typeof body.code === 'string' ? body.code : undefined });
  }
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

/** The workspace time zone (Settings > Workspace), which a campaign's "Send at" is read in. */
export async function fetchWorkspaceTimeZone(): Promise<string> {
  const body = await call<{ settings?: { timezone?: unknown } }>('/api/inbox/settings', { method: 'GET', cache: 'no-store' },
    'Could not load the workspace time zone');
  const zone = body.settings?.timezone;
  if (typeof zone !== 'string' || !zone) throw new Error('Could not load the workspace time zone');
  return zone;
}

/** Cancel a scheduled campaign before it starts. */
export function cancelSchedule(id: string): Promise<unknown> {
  return call(`/api/broadcasts/${encodeURIComponent(id)}/schedule`, { method: 'DELETE' }, 'Could not cancel the schedule');
}

/** "Cancel remaining": stop a sending or paused campaign for good. */
export function cancelRemaining(id: string): Promise<{ cancelled: number; heldForReview: number }> {
  return call(`/api/broadcasts/${encodeURIComponent(id)}/cancel-remaining`, { method: 'POST', body: '{}' }, 'Could not cancel the campaign');
}

/** Who a WhatsApp campaign reaches now, by the rules creation applies; and the workspace time zone. */
export function campaignReach(audience: AudienceConfig): Promise<{ count: number; timeZone: string }> {
  const { csvText: _text, csvFileName: _file, ...rest } = audience;
  void _text; void _file;
  const body = {
    ...rest,
    // CSV rows need only their number to be counted.
    csvContacts: audience.type === 'csv' ? audience.csvContacts?.map((row) => ({ phone: row.phone })) : undefined,
    allowDuplicates: audience.type === 'csv' && audience.allowDuplicates ? true : undefined,
    consentConfirmed: undefined,
  };
  return call('/api/broadcasts/reach', { method: 'POST', body: JSON.stringify({ audience: body }) }, 'Could not count the audience');
}

/** A draft as the wizard saves and reopens it (lib/broadcasts/drafts). */
export interface CampaignDraftPayload {
  name: string;
  channel: 'whatsapp' | 'instagram';
  text?: string;
  templateId?: string | null;
  variables?: Record<string, { type: string; value: string }>;
  headerMediaUrl?: string;
  trackedUrl?: string;
  sendExtras?: Record<string, unknown>;
  scheduledAt?: string;
  whatsappConfigId?: string | null;
  sendWindow?: { start: number; end: number } | null;
  audience: AudienceConfig;
}

/** Save a draft (new, or replacing `id`); returns its id. */
export async function saveCampaignDraft(draft: CampaignDraftPayload, id?: string | null): Promise<string> {
  const { csvText: _text, ...audience } = draft.audience;
  void _text;
  const result = await call<{ id?: unknown }>(id ? `/api/broadcasts/drafts/${encodeURIComponent(id)}` : '/api/broadcasts/drafts', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify({ ...draft, audience }),
  }, 'Could not save the draft');
  if (typeof result.id !== 'string') throw new Error('Saving the draft returned no identifier');
  return result.id;
}

/** Remove a draft once the campaign it was finishing is created. */
export function deleteCampaignDraft(id: string): Promise<unknown> {
  return call(`/api/broadcasts/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not remove the draft');
}

export async function loadCampaignDraft(id: string): Promise<CampaignDraftPayload> {
  return (await call<{ draft: CampaignDraftPayload }>(`/api/broadcasts/drafts/${encodeURIComponent(id)}`, { method: 'GET' }, 'Could not open the draft')).draft;
}

/** "Create segment from this result" on a campaign report. */
export async function createResultSegment(id: string, result: string): Promise<{ id: string; name: string }> {
  return (await call<{ segment: { id: string; name: string } }>(`/api/broadcasts/${encodeURIComponent(id)}/segment`, {
    method: 'POST', body: JSON.stringify({ result }),
  }, 'Could not create the segment')).segment;
}
