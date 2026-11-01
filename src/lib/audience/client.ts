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

/** Campaign reach: exact and consent-aware for segments, an estimate otherwise. */
export async function audienceReach(audience: AudienceConfig): Promise<number | null> {
  if (audience.type === 'segment') return audience.segmentId ? (await previewSegment({ segmentId: audience.segmentId })).sendable : null;
  return countAudience(createClient(), audience);
}
