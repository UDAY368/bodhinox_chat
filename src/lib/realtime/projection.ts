import { internalFields } from '@/lib/data/contracts';

/** Outbox snapshots remain complete in PostgreSQL; browser events omit internals. */
export function projectRealtimePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return payload;
  const event = payload as Record<string, unknown>;
  const project = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => !internalFields.has(key))
        )
      : value;
  return { ...event, new: project(event.new), old: project(event.old) };
}
