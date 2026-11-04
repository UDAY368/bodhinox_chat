/**
 * Phase 9 meeting contracts (design §1-§2). Pure: no server-only imports.
 * The CHECK lists in prisma/migrations/20261108100000_meeting_integration
 * mirror these unions.
 */
import type { TenantContext } from '@/lib/db/tenant';

export const MEETING_PROVIDERS = ['zoom'] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

export const MEETING_CONNECTION_STATUSES = ['active', 'token_invalid', 'disconnected'] as const;
export type MeetingConnectionStatus = (typeof MEETING_CONNECTION_STATUSES)[number];

/**
 * creating: claimed, the provider call may be in flight; unknown: the create
 * outcome was ambiguous (reconcile by meeting_ref, never re-create); detached:
 * created under a previous connection; manual: staff chose the supplied link.
 */
export const MEETING_SYNC_STATES = ['creating', 'active', 'unknown', 'failed', 'deleted', 'manual', 'detached'] as const;
export type MeetingSyncState = (typeof MEETING_SYNC_STATES)[number];

/** Evidence only, ordered weakest first; never an appointment status. */
export const ATTENDANCE_EVIDENCE = ['none', 'guest_joined', 'registrant_joined'] as const;
export type AttendanceEvidence = (typeof ATTENDANCE_EVIDENCE)[number];

export const PARTICIPANT_EVENT_KINDS = ['meeting_started', 'participant_joined', 'participant_left', 'meeting_ended'] as const;
export type ParticipantEventKind = (typeof PARTICIPANT_EVENT_KINDS)[number];
export const PARTICIPANT_KINDS = ['host', 'registrant', 'guest'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** Job types (routed by src/lib/jobs/handlers.ts). */
export const MEETING_SYNC_JOB = 'appointments.meeting_sync';
export const ZOOM_EVENT_JOB = 'meetings.zoom_event';

/** Payload of appointments.meeting_sync (dedupe appointmentKeys.meetingSync). */
export interface MeetingSyncPayload {
  appointmentId: string;
  version: number;
}
export interface MeetingJobMeta {
  attempts: number;
  maxAttempts: number;
}

/** A signed-in member acting through a meeting service (route checked role and permission). */
export type MeetingActor = TenantContext & { userId: string };

/** Code-only refusals; the UI translates them (Validation.meetings.*). */
export const MEETING_ERROR_CODES = [
  'not_configured', 'not_connected', 'zoom_account_in_use', 'auth', 'provider_unreachable', 'invalid_state',
  'missing_scopes', 'not_found', 'conflict', 'feature_unavailable', 'not_implemented',
] as const;
export type MeetingErrorCode = (typeof MEETING_ERROR_CODES)[number];

const STATUS: Record<MeetingErrorCode, number> = {
  not_configured: 503,
  not_connected: 409,
  zoom_account_in_use: 409,
  auth: 400,
  provider_unreachable: 502,
  invalid_state: 400,
  missing_scopes: 400,
  not_found: 404,
  conflict: 409,
  feature_unavailable: 402,
  not_implemented: 501,
};

export class MeetingError extends Error {
  readonly status: number;
  constructor(readonly code: MeetingErrorCode) {
    super(code);
    this.name = 'MeetingError';
    this.status = STATUS[code];
  }
}

/** The public view of a workspace's Zoom connection (never a token). */
export interface MeetingConnectionDto {
  /** false when this deployment has no Zoom app configuration (mutations answer 503 not_configured). */
  available: boolean;
  connected: boolean;
  status: MeetingConnectionStatus | null;
  register_attendees: boolean;
  last_error_code: string | null;
  connected_at: string | null;
}

/** What the appointment sheet shows about a meeting (no registrant id, no claim token). */
export interface AppointmentMeetingView {
  sync_state: MeetingSyncState;
  join_url: string | null;
  supplied_url: string | null;
  last_error_code: string | null;
  attendance_evidence: AttendanceEvidence;
  first_join_at: string | null;
  attended_seconds: number;
  meeting_ended_at: string | null;
}
