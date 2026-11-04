import { describe, expect, it } from 'vitest';
import { attendedSeconds, EARLY_EVENT_MARGIN_MS, inSessionWindow, participantKind, strongerEvidence, type EvidenceRow } from './attendance';

const at = (min: number) => new Date(Date.UTC(2026, 10, 9, 10, min));
const row = (kind: EvidenceRow['kind'], who: EvidenceRow['participant_kind'], key: string | null, min: number): EvidenceRow =>
  ({ kind, participant_kind: who, participant_key: key, event_at: at(min) });

describe('strongerEvidence', () => {
  it('only rises', () => {
    expect(strongerEvidence('none', 'guest_joined')).toBe('guest_joined');
    expect(strongerEvidence('guest_joined', 'registrant_joined')).toBe('registrant_joined');
    expect(strongerEvidence('registrant_joined', 'guest_joined')).toBe('registrant_joined');
    expect(strongerEvidence('guest_joined', 'none')).toBe('guest_joined');
  });
});

describe('participantKind', () => {
  it('detects the host by Zoom user id, our registrant by registrant id, and everyone else as a guest', () => {
    expect(participantKind({ hostId: 'H1', participantUserId: 'H1', registrantId: null }, 'r1')).toBe('host');
    expect(participantKind({ hostId: 'H1', participantUserId: 'U2', registrantId: 'r1' }, 'r1')).toBe('registrant');
    expect(participantKind({ hostId: 'H1', participantUserId: 'U2', registrantId: 'r2' }, 'r1')).toBe('guest');
    expect(participantKind({ hostId: 'H1', participantUserId: null, registrantId: null }, null)).toBe('guest');
    // No host id in the event: never guessed to be the host.
    expect(participantKind({ hostId: null, participantUserId: 'H1', registrantId: null }, null)).toBe('guest');
  });
});

describe('attendedSeconds', () => {
  it('sums join/leave pairs per participant and ignores the host', () => {
    expect(attendedSeconds([
      row('participant_joined', 'host', 'h', 0), row('participant_left', 'host', 'h', 60),
      row('participant_joined', 'guest', 'g', 2), row('participant_left', 'guest', 'g', 26),
    ], null)).toBe(24 * 60);
  });

  it('counts overlapping participants once and is order-independent', () => {
    const rows = [
      row('participant_joined', 'guest', 'a', 0), row('participant_left', 'guest', 'a', 10),
      row('participant_joined', 'guest', 'b', 5), row('participant_left', 'guest', 'b', 15),
      row('participant_joined', 'guest', 'a', 20), row('participant_left', 'guest', 'a', 25),
    ];
    expect(attendedSeconds(rows, null)).toBe(20 * 60);
    expect(attendedSeconds([...rows].reverse(), null)).toBe(20 * 60);
  });

  it('closes an open interval at the meeting end, and does not count it while the meeting runs', () => {
    const rows = [row('participant_joined', 'guest', 'g', 5)];
    expect(attendedSeconds(rows, null)).toBe(0);
    expect(attendedSeconds(rows, at(35))).toBe(30 * 60);
  });

  it('counts only our registrant once the registrant joined', () => {
    expect(attendedSeconds([
      row('participant_joined', 'guest', 'g', 0), row('participant_left', 'guest', 'g', 40),
      row('participant_joined', 'registrant', 'r', 10), row('participant_left', 'registrant', 'r', 20),
    ], null)).toBe(10 * 60);
  });

  it('ignores duplicate joins, a leave without a join, and rows without a key', () => {
    expect(attendedSeconds([
      row('participant_left', 'guest', 'g', 1),
      row('participant_joined', 'guest', 'g', 2), row('participant_joined', 'guest', 'g', 3), row('participant_left', 'guest', 'g', 12),
      row('participant_joined', 'guest', null, 0), row('meeting_started', null, null, 0),
    ], at(60))).toBe(10 * 60);
  });
});

describe('inSessionWindow', () => {
  it('ignores a session well before the appointment (a host test the day before) and keeps early joins', () => {
    const start = at(0);
    expect(inSessionWindow(new Date(start.getTime() - 24 * 3600_000), start)).toBe(false);
    expect(inSessionWindow(new Date(start.getTime() - EARLY_EVENT_MARGIN_MS - 1), start)).toBe(false);
    expect(inSessionWindow(new Date(start.getTime() - 10 * 60_000), start)).toBe(true);
    expect(inSessionWindow(at(45), start)).toBe(true);
  });
});
