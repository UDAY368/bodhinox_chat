import { getAuthPrisma } from '@/lib/db/prisma';
import { AuthError } from './errors';
import type { AuthContext } from './session';
import { parseUserAgent, storableUserAgent, type DeviceInfo } from './user-agent';

export interface DeviceSession extends DeviceInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  /** Not collected: no IP address or location is stored for sessions. */
  location: null;
}
type Row = { id: string; user_agent: string | null; created_at: Date; last_used_at: Date };

/**
 * Records the device for a session that has none yet. Sign-in through Google stores it directly;
 * password sign-in can call this after login, and the device list fills in the current session.
 */
export async function recordSessionDevice(
  sessionId: string,
  userAgent: string | null | undefined
): Promise<void> {
  const value = storableUserAgent(userAgent);
  if (!value) return;
  await getAuthPrisma()
    .$executeRaw`UPDATE auth_sessions SET user_agent=${value} WHERE id=${sessionId}::uuid AND user_agent IS NULL`;
}

/** The signed-in user's active sessions, newest activity first. Refresh rotation marks activity. */
export async function listDeviceSessions(
  context: Pick<AuthContext, 'userId' | 'sessionId'>
): Promise<DeviceSession[]> {
  const rows = await getAuthPrisma().$queryRaw<Row[]>`
    SELECT s.id,s.user_agent,s.created_at,GREATEST(s.created_at,COALESCE(MAX(r.created_at),s.created_at)) AS last_used_at
    FROM auth_sessions s LEFT JOIN auth_refresh_tokens r ON r.session_id=s.id
    WHERE s.user_id=${context.userId}::uuid AND s.revoked_at IS NULL AND s.expires_at>NOW()
    GROUP BY s.id ORDER BY last_used_at DESC LIMIT 100`;
  return rows.map((row) => ({
    id: row.id,
    current: row.id === context.sessionId,
    ...parseUserAgent(row.user_agent),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at.toISOString(),
    location: null,
  }));
}

/** Revokes one of the user's other sessions. The current one is ended with sign-out instead. */
export async function revokeDeviceSession(
  context: Pick<AuthContext, 'userId' | 'sessionId'>,
  sessionId: string
): Promise<boolean> {
  if (sessionId === context.sessionId)
    throw new AuthError('Use sign out to end this session', 400, 'current_session');
  const count = await getAuthPrisma().$executeRaw`
    UPDATE auth_sessions SET revoked_at=NOW()
    WHERE id=${sessionId}::uuid AND user_id=${context.userId}::uuid AND revoked_at IS NULL`;
  return count > 0;
}

export async function revokeOtherDeviceSessions(
  context: Pick<AuthContext, 'userId' | 'sessionId'>
): Promise<number> {
  return getAuthPrisma().$executeRaw`
    UPDATE auth_sessions SET revoked_at=NOW()
    WHERE user_id=${context.userId}::uuid AND id<>${context.sessionId}::uuid AND revoked_at IS NULL`;
}
