import { formatDistanceStrict } from 'date-fns'

export function flowRunDuration(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null
  const start = new Date(startedAt), end = new Date(endedAt)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return null
  return formatDistanceStrict(end, start)
}
