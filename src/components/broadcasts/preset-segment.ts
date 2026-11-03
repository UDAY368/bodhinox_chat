import type { AudienceConfig } from '@/lib/broadcast-audience';

/**
 * Applies a segment preset from the new-broadcast URL (?segmentId=). The id is
 * used only when it is one of the workspace's own saved segments and the
 * audience is still the untouched default; otherwise the audience is kept.
 */
export function presetSegmentAudience(
  current: AudienceConfig,
  segmentId: string,
  segments: readonly { id: string }[],
): AudienceConfig {
  if (current.type !== 'all') return current;
  if (!segments.some((s) => s.id === segmentId)) return current;
  return { type: 'segment', segmentId };
}
