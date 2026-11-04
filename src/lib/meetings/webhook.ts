// Zoom webhook verification and minimisation (Phase 9, design D5). Owner: T3.
//
// Zoom signs every event notification of the General app with the app's
// webhook secret token: x-zm-signature = 'v0=' + hex(HMAC-SHA256(secret,
// 'v0:' + x-zm-request-timestamp + ':' + rawBody)). We verify over the raw
// bytes (Zoom's sample re-serializes the parsed body, which only matches
// because Zoom sends compact JSON). Pure: no database, no network.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Maximum skew accepted on x-zm-request-timestamp. */
export const ZOOM_SIGNATURE_SKEW_SECONDS = 300;

/** The events this app subscribes to (docs/deployment/railway.md); anything else is acknowledged and ignored. */
export const ZOOM_EVENTS = [
  'meeting.started', 'meeting.ended', 'meeting.participant_joined', 'meeting.participant_left', 'app_deauthorized',
] as const;
export type ZoomEventName = (typeof ZOOM_EVENTS)[number];
export const isZoomEvent = (value: unknown): value is ZoomEventName =>
  typeof value === 'string' && (ZOOM_EVENTS as readonly string[]).includes(value);

const TIMESTAMP = /^[0-9]{9,13}$/;
const SIGNATURE = /^v0=[0-9a-f]{64}$/;

/**
 * x-zm-signature == 'v0=' + hex(HMAC-SHA256(secret, 'v0:' + timestamp + ':' + rawBody)),
 * compared in constant time, timestamp within the skew. `now` in milliseconds.
 * The timestamp header is in seconds (Zoom docs); a millisecond value is accepted defensively.
 */
export function verifyZoomSignature(
  raw: string, timestamp: string | null, signature: string | null, secret: string, now: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature || !TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature)) return false;
  const value = Number(timestamp);
  const seconds = timestamp.length >= 13 ? Math.floor(value / 1000) : value;
  if (Math.abs(Math.floor(now / 1000) - seconds) > ZOOM_SIGNATURE_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** endpoint.url_validation answer: encryptedToken = hex(HMAC-SHA256(secret, plainToken)). */
export function urlValidationResponse(plainToken: string, secret: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex') };
}

/** Ids and timestamps only: never a participant name or email. */
export interface MinimalZoomEvent {
  event: string;
  zoomAccountId: string | null;
  meetingId: string | null;
  hostId: string | null;
  participantUserId: string | null;
  /** sha256 hex of the participant_uuid. */
  participantKey: string | null;
  registrantId: string | null;
  /** event_ts in milliseconds since the epoch. */
  eventTs: number | null;
  joinTime: string | null;
  leaveTime: string | null;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null);
const ZOOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MEETING_ID = /^[0-9]{1,20}$/;
const REGISTRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function id(value: unknown, pattern: RegExp): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && pattern.test(text) ? text : null;
}
/** An ISO timestamp, re-serialized (so nothing but a date survives). */
function time(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Reduces a verified Zoom event to ids and timestamps. Returns null when the
 * body is not an object with an event name. Names, emails, phone numbers,
 * topics, IPs and locations are never copied.
 *
 * Assumptions (Zoom docs, not all confirmed): the participant's Zoom user id is
 * `participant.id` (falling back to `participant_user_id`), compared with the
 * meeting's `host_id` to detect the host; `participant_uuid` is stable for one
 * participant in one meeting instance (falling back to the per-session
 * `user_id`, hashed with a different prefix).
 */
export function minimiseZoomEvent(body: unknown): MinimalZoomEvent | null {
  const root = obj(body);
  if (!root || typeof root.event !== 'string' || !/^[a-z_.]{1,64}$/.test(root.event)) return null;
  const payload = obj(root.payload) ?? {};
  const object = obj(payload.object) ?? {};
  const participant = obj(object.participant) ?? {};
  const participantUuid = typeof participant.participant_uuid === 'string' && participant.participant_uuid.length <= 200
    ? participant.participant_uuid : null;
  const sessionUserId = id(participant.user_id, /^[A-Za-z0-9_-]{1,64}$/);
  // app_deauthorized also carries deauthorization_time: the fallback when event_ts is missing.
  const deauthorizedAt = time(payload.deauthorization_time);
  const eventTs = typeof root.event_ts === 'number' && Number.isSafeInteger(root.event_ts) && root.event_ts > 0 ? root.event_ts
    : deauthorizedAt ? Date.parse(deauthorizedAt) : null;
  return {
    event: root.event,
    zoomAccountId: id(payload.account_id, ZOOM_ID),
    meetingId: id(object.id, MEETING_ID),
    hostId: id(object.host_id, ZOOM_ID),
    participantUserId: id(participant.id, ZOOM_ID) ?? id(participant.participant_user_id, ZOOM_ID),
    participantKey: participantUuid ? sha256(participantUuid) : sessionUserId ? sha256(`session:${sessionUserId}`) : null,
    registrantId: id(participant.registrant_id, REGISTRANT_ID),
    eventTs,
    joinTime: time(participant.join_time),
    leaveTime: time(participant.leave_time),
  };
}

/** Validates a minimised event read back from a job payload (the job never trusts its own payload shape). */
export function parseMinimalZoomEvent(value: unknown): MinimalZoomEvent | null {
  const p = obj(value);
  if (!p || typeof p.event !== 'string') return null;
  const str = (k: string, pattern: RegExp) => (p[k] === null || p[k] === undefined ? null : id(p[k], pattern));
  const iso = (k: string) => (p[k] === null || p[k] === undefined ? null : time(p[k]));
  const eventTs = typeof p.eventTs === 'number' && Number.isSafeInteger(p.eventTs) && p.eventTs > 0 ? p.eventTs : null;
  return {
    event: p.event,
    zoomAccountId: str('zoomAccountId', ZOOM_ID),
    meetingId: str('meetingId', MEETING_ID),
    hostId: str('hostId', ZOOM_ID),
    participantUserId: str('participantUserId', ZOOM_ID),
    participantKey: str('participantKey', /^[0-9a-f]{64}$/),
    registrantId: str('registrantId', REGISTRANT_ID),
    eventTs,
    joinTime: iso('joinTime'),
    leaveTime: iso('leaveTime'),
  };
}
