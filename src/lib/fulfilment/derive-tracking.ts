// Tracking fold (Phase 9, design D11). Owner: T5.
//
// A pure, total fold over the full, time-sorted scan history (stored events
// and re-fetched events), so any arrival order of pushes gives the same result.
// Input is deduplicated by (providerCode, eventAt) and sorted by
// (eventAt, rank, status, providerCode), a total order, then folded:
//   1. state terminal and the next status differs → stay terminal, record a
//      contradiction (unless an admin accepted that correction, see below);
//   2. next rank lower than the current rank (non-terminal) → ignore;
//   3. equal rank → the later event wins (out_for_delivery / delivery_failed);
//   4. else advance.
//
// An accepted correction (admin "Accept correction" on a contradiction
// exception) lets the fold leave a terminal state for exactly that observed
// status, so a re-fetch after the correction does not undo it or reopen it.
import { DISPATCH_EVIDENCE_STATUSES, RTO_TRACKING_STATUSES, TERMINAL_TRACKING_STATUSES, TRACKING_RANK } from './status-map';
import type { TrackingStatus } from './types';

export interface TrackingEvent {
  status: TrackingStatus;
  providerCode: string;
  eventAt: Date;
}

export interface DerivedTracking {
  status: TrackingStatus | null;
  rank: number;
  eventAt: Date | null;
  firstDispatchAt: Date | null;
  deliveredAt: Date | null;
  /** Statuses observed after a terminal state (each opens a contradiction exception). */
  contradictions: TrackingStatus[];
  rto: boolean;
  lost: boolean;
}

export interface DeriveOptions {
  /** Observed statuses whose contradiction an admin accepted (they may leave a terminal state). */
  acceptedCorrections?: ReadonlySet<TrackingStatus>;
}

function compare(a: TrackingEvent, b: TrackingEvent): number {
  return a.eventAt.getTime() - b.eventAt.getTime()
    || TRACKING_RANK[a.status] - TRACKING_RANK[b.status]
    || (a.status < b.status ? -1 : a.status > b.status ? 1 : 0)
    || (a.providerCode < b.providerCode ? -1 : a.providerCode > b.providerCode ? 1 : 0);
}

export function deriveTracking(events: readonly TrackingEvent[], options: DeriveOptions = {}): DerivedTracking {
  const accepted = options.acceptedCorrections ?? new Set<TrackingStatus>();
  const unique = new Map<string, TrackingEvent>();
  for (const e of events) {
    if (!e || !Object.prototype.hasOwnProperty.call(TRACKING_RANK, e.status) ||!(e.eventAt instanceof Date) || Number.isNaN(e.eventAt.getTime())) continue;
    const key = `${e.providerCode}\u0000${e.eventAt.getTime()}`;
    const seen = unique.get(key);
    // Same code and time twice with different statuses cannot come from one scan; keep a deterministic one.
    if (!seen || compare(e, seen) < 0) unique.set(key, e);
  }
  const sorted = [...unique.values()].sort(compare);

  let status: TrackingStatus | null = null;
  let eventAt: Date | null = null;
  let firstDispatchAt: Date | null = null;
  let deliveredAt: Date | null = null;
  let rto = false;
  const contradictions: TrackingStatus[] = [];

  const apply = (e: TrackingEvent) => {
    status = e.status;
    eventAt = e.eventAt;
    if (!firstDispatchAt && DISPATCH_EVIDENCE_STATUSES.has(e.status)) firstDispatchAt = e.eventAt;
    if (e.status === 'delivered' && !deliveredAt) deliveredAt = e.eventAt;
    if (RTO_TRACKING_STATUSES.has(e.status)) rto = true;
  };

  for (const e of sorted) {
    const current: TrackingStatus | null = status;
    if (current === null) { apply(e); continue; }
    if (TERMINAL_TRACKING_STATUSES.has(current)) {
      if (e.status === current) continue;
      if (accepted.has(e.status)) { apply(e); continue; }
      if (!contradictions.includes(e.status)) contradictions.push(e.status);
      continue;
    }
    if (TRACKING_RANK[e.status] < TRACKING_RANK[current]) continue;
    apply(e);
  }

  const final = status as TrackingStatus | null;
  return {
    status: final,
    rank: final ? TRACKING_RANK[final] : 0,
    eventAt,
    firstDispatchAt,
    deliveredAt,
    contradictions,
    rto,
    lost: final === 'lost',
  };
}
