'use client';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { countAudience, type AudienceConfig } from '@/lib/broadcast-audience';
import type { AudienceFilter } from './filter';

export interface SegmentSummary { id: string; name: string; filter: AudienceFilter }

export async function fetchSegments(): Promise<SegmentSummary[]> {
  const res = await authFetch('/api/segments', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load segments');
  return ((await res.json()) as { segments: SegmentSummary[] }).segments;
}

export async function previewSegment(source: { filter: AudienceFilter } | { segmentId: string }): Promise<{ total: number; sendable: number }> {
  const res = await authFetch('/api/segments/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(source),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Could not count this audience');
  return payload as { total: number; sendable: number };
}

export interface ListSummary { id: string; name: string; member_count: number }

export async function fetchLists(): Promise<ListSummary[]> {
  const res = await authFetch('/api/lists', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load lists');
  return ((await res.json()) as { lists: ListSummary[] }).lists;
}

/** Add or remove contacts; returns the server's error message on failure. */
export async function changeListMembers(listId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
  const res = await authFetch(`/api/lists/${listId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not update the list');
}

/** Campaign reach: exact and consent-aware for segments and lists, an estimate otherwise. */
export async function audienceReach(audience: AudienceConfig): Promise<number | null> {
  if (audience.type === 'segment') return audience.segmentId ? (await previewSegment({ segmentId: audience.segmentId })).sendable : null;
  if (audience.type === 'list')
    return audience.listId
      ? (await previewSegment({ filter: { conditions: [{ field: 'list', op: 'in_any', listIds: [audience.listId] }] } })).sendable
      : null;
  return countAudience(createClient(), audience);
}
