import { randomUUID } from 'node:crypto';
import { authEmailTransport as emailTransport, sendAuthEmail } from './email';
import { getAuthPrisma } from '@/lib/db/prisma';
import {
  appOrigin,
  assertCsrf,
  assertOrigin,
  hashToken,
  randomToken,
} from './csrf';
import { signAccessToken } from './jwt';
import { hashPassword, verifyPassword } from './password';
import { AuthError, UnauthorizedError } from './errors';
import { type AuthContext } from './session';
import { checkMfa } from './mfa';
import { safeNextPath } from './callback';
import { storableUserAgent } from './user-agent';
import { hashInviteToken, INVITE_TOKEN_PATTERN } from './invitations';
import { assignInitialPlan } from '@/lib/billing/new-workspace-plan';

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
type AuthDatabase = ReturnType<typeof getAuthPrisma>;
export type AuthTransaction = Pick<AuthDatabase, '$queryRaw' | '$executeRaw'>;
type Identity = {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  email_verified_at: Date | null;
  disabled_at: Date | null;
};
export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  expiresAt: Date;
}
/** A newly created session: sign-in returns its id (refresh rotation keeps the same session). */
export type NewSession = IssuedSession & { sessionId: string };
function normalizeEmail(email: string): string {
  const normalized =
    typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new AuthError('Enter a valid email', 400);
  return normalized;
}
// 10 attempts per identity per 15 minutes. The Playwright suite clears auth_rate_limits in its
// isolated test database before each sign-in (e2e/fixtures.ts), so it never needs a higher limit.
export async function enforceAuthRateLimit(
  action: string,
  identity: string,
  maximum = 10,
  windowSeconds = 900
): Promise<void> {
  const key = hashToken(`${action}:${identity.trim().toLowerCase()}`);
  const rows = await getAuthPrisma().$queryRaw<{ attempts: number }[]>`
    INSERT INTO auth_rate_limits(key,attempts,reset_at) VALUES(${key},1,NOW()+${windowSeconds}*INTERVAL '1 second')
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.reset_at<=NOW() THEN 1 ELSE auth_rate_limits.attempts+1 END,
      reset_at=CASE WHEN auth_rate_limits.reset_at<=NOW() THEN NOW()+${windowSeconds}*INTERVAL '1 second' ELSE auth_rate_limits.reset_at END
    RETURNING attempts`;
  if (rows[0].attempts > maximum)
    throw new AuthError(
      'Too many attempts. Try again later.',
      429,
      'rate_limited'
    );
}
async function sendVerification(
  email: string,
  token: string,
  purpose: string,
  next = '/dashboard'
) {
  const link = new URL('/auth/callback', appOrigin());
  link.searchParams.set('token', token);
  link.searchParams.set('purpose', purpose);
  link.searchParams.set('next', safeNextPath(next));
  await sendAuthEmail({
    from: process.env.AUTH_EMAIL_FROM,
    to: email,
    subject:
      purpose === 'reset'
        ? 'Reset your Bodhinox password'
        : 'Verify your Bodhinox email',
    text: `${purpose === 'reset' ? 'Reset your password' : 'Verify your email'}: ${link.toString()}\nThis link expires in ${purpose === 'reset' ? 'one hour' : '24 hours'}. If you did not request it, ignore this message.`,
  });
}
async function createVerification(
  userId: string,
  purpose: 'verify' | 'reset',
  metadata: Record<string, string> = {}
): Promise<string> {
  const token = randomToken(),
    id = randomUUID();
  const expires = new Date(
    Date.now() + (purpose === 'reset' ? 3600_000 : 86400_000)
  );
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
    // Verify links stay valid side by side: each carries the password of the signup that asked
    // for it, and the inbox owner picks theirs by typing it (verifyEmailToken). Consuming them
    // here would let a later signup by someone else void the real owner's pending link.
    if (purpose !== 'verify')
      await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${userId}::uuid AND purpose=${purpose} AND consumed_at IS NULL`;
    await tx.$executeRaw`INSERT INTO auth_verifications(id,user_id,purpose,token_hash,expires_at,metadata) VALUES(${id}::uuid,${userId}::uuid,${purpose},${hashToken(token)},${expires},${JSON.stringify(metadata)}::jsonb)`;
  });
  return token;
}
/**
 * The terms version new sign-ups must accept (TERMS_VERSION), or null when unset: then signup
 * behaves exactly as before and nothing is stored.
 */
export function currentTermsVersion(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.TERMS_VERSION?.trim();
  return value ? value.slice(0, 40) : null;
}
/** Refuses a signup that did not accept the current terms version (only while TERMS_VERSION is set). */
export function assertTermsAccepted(accepted: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const current = currentTermsVersion(env);
  if (current && accepted !== current)
    throw new AuthError('Accept the terms of service to create an account', 400, 'terms_required');
  return current;
}
export const INVITE_ROLES = ['admin', 'agent', 'viewer'] as const;
export function inviteUnavailable(): AuthError {
  return new AuthError(
    'This invitation link is no longer valid. Ask for a new link or sign up without it.',
    410,
    'invite_unavailable'
  );
}
type LockedInvite = { id: string; account_id: string; role: string };
/** Locks an open invitation by token for the rest of the transaction, or refuses it. */
export async function lockOpenInvitation(
  tx: AuthTransaction,
  token: string
): Promise<LockedInvite> {
  if (!INVITE_TOKEN_PATTERN.test(token)) throw inviteUnavailable();
  const invite = await lockInvitationByHash(tx, hashInviteToken(token));
  if (!invite) throw inviteUnavailable();
  return invite;
}
async function lockInvitationByHash(
  tx: AuthTransaction,
  tokenHash: string
): Promise<LockedInvite | null> {
  const rows = await tx.$queryRaw<LockedInvite[]>`
    SELECT id,account_id,role FROM account_invitations
    WHERE token_hash=${tokenHash} AND accepted_at IS NULL AND expires_at>NOW() FOR UPDATE`;
  const invite = rows[0];
  if (!invite || !(INVITE_ROLES as readonly string[]).includes(invite.role)) return null;
  // A workspace whose deletion was requested takes no new members.
  const [closing] = await tx.$queryRaw<{ closing: boolean }[]>`SELECT auth_workspace_closing(${invite.account_id}::uuid) AS closing`;
  return closing?.closing ? null : invite;
}
/**
 * Joins an identity to the invited workspace with the invitation's role instead of creating a
 * personal workspace (email signup at verification, Google signup), and marks it redeemed.
 */
export async function joinInvitedWorkspace(
  tx: AuthTransaction,
  invite: LockedInvite,
  user: { id: string; fullName: string; email: string },
  via: 'verify' | 'google' = 'verify'
): Promise<void> {
  await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${invite.account_id}::uuid,${user.id}::uuid,${invite.role})
    ON CONFLICT(account_id,user_id) DO NOTHING`;
  await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${user.id}::uuid,${user.fullName},${user.email},${invite.account_id}::uuid,${invite.role})
    ON CONFLICT(user_id) DO NOTHING`;
  await tx.$executeRaw`UPDATE account_invitations SET accepted_at=NOW(),accepted_by_user_id=${user.id}::uuid WHERE id=${invite.id}::uuid`;
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${invite.account_id}::uuid,${user.id}::uuid,'invitation.redeemed',${invite.id},${JSON.stringify({ role: invite.role, via })}::jsonb)`;
}
/** Creates "<name>'s workspace" owned by the user (email signup, and sign-in with no membership left). */
async function createPersonalWorkspace(
  tx: AuthTransaction,
  user: { id: string; fullName: string; email: string }
): Promise<string> {
  const accountId = randomUUID();
  await tx.$executeRaw`SELECT set_config('app.user_id',${user.id},true),set_config('app.account_id',${accountId},true),set_config('app.account_role','owner',true)`;
  await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${accountId}::uuid,${`${user.fullName}'s workspace`},${user.id}::uuid)`;
  await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${accountId}::uuid,${user.id}::uuid,'owner')`;
  await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${user.id}::uuid,${user.fullName},${user.email},${accountId}::uuid,'owner')
    ON CONFLICT(user_id) DO NOTHING`;
  // NEW_WORKSPACE_PLAN (unset = no subscription row = enterprise, as before).
  await assignInitialPlan(tx, accountId);
  return accountId;
}
export async function signup(input: {
  email: string;
  password: string;
  fullName?: string;
  next?: string;
  /** Invitation link token: join that workspace instead of creating one. */
  invite?: string;
  /** The terms version the person accepted; required to equal TERMS_VERSION while that is set. */
  termsVersion?: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const terms = assertTermsAccepted(input.termsVersion);
  await enforceAuthRateLimit('signup', email, 5, 3600);
  emailTransport(); // Reject before creating an identity when delivery is not configured.
  const passwordHash = await hashPassword(input.password);
  const fullName = (input.fullName ?? '').trim().slice(0, 200);
  if (!fullName) throw new AuthError('Enter your name', 400);
  const invite = input.invite;
  if (invite !== undefined && !INVITE_TOKEN_PATTERN.test(invite))
    throw inviteUnavailable();
  const userId = randomUUID();
  const user = await getAuthPrisma().$transaction(async (tx) => {
    // Check the invitation before touching auth_users, so a dead link gets the same 410 whether
    // or not the email is registered (no enumeration). It is redeemed only at email verification.
    if (invite) await lockOpenInvitation(tx, invite);
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO auth_users(id,email,full_name,password_hash,terms_version,terms_accepted_at)
      VALUES(${userId}::uuid,${email},${fullName},${passwordHash},${terms},${terms ? new Date() : null}::timestamptz)
      ON CONFLICT(email) DO NOTHING RETURNING id`;
    // A failed delivery must not strand a pending signup. Reissue proof without exposing whether
    // a verified account exists. The password stays out of auth_users here: it rides on the new
    // verify link and is applied only when the inbox owner verifies by typing it (account
    // pre-hijack: an unverified row may have been created by someone else).
    if (!inserted[0]) {
      const existing = await tx.$queryRaw<{ id: string; verified: boolean }[]>`
        SELECT id, email_verified_at IS NOT NULL AS verified
        FROM auth_users WHERE email=${email} AND disabled_at IS NULL`;
      return existing[0] ? { ...existing[0] } : null;
    }
    // Invited people get no personal owner workspace: verifying the email joins the invited one.
    if (!invite)
      await createPersonalWorkspace(tx, { id: userId, fullName, email });
    return { ...inserted[0], verified: false };
  });
  if (user?.verified) {
    // Same response as a new signup, so the form never reveals which emails are registered;
    // the owner of the address still learns why no verification link arrived.
    const signIn = new URL('/login', appOrigin());
    const join = invite
      ? `\nTo join the workspace you were invited to, sign in and open: ${new URL(`/join/${encodeURIComponent(invite)}`, appOrigin()).toString()}`
      : '';
    await sendAuthEmail({
      from: process.env.AUTH_EMAIL_FROM,
      to: email,
      subject: 'You already have a Bodhinox account',
      text: `Someone tried to create a Bodhinox account with this email, but one already exists.
Sign in: ${signIn.toString()}${join}
Forgot your password? Use "Forgot password" on the sign-in page. If this wasn't you, ignore this message.`,
    });
  } else if (user)
    await sendVerification(
      email,
      // The verification carries this signup's password hash, name and terms, plus the invitation
      // (hash only); verifyEmailToken applies them once the email owner proves the password.
      await createVerification(user.id, 'verify', {
        passwordHash,
        fullName,
        ...(terms ? { termsVersion: terms } : {}),
        ...(invite ? { inviteTokenHash: hashInviteToken(invite) } : {}),
      }),
      'verify',
      invite ? '/dashboard' : input.next
    );
}
let dummyPasswordHash: Promise<string> | undefined;
export async function login(input: {
  email: string;
  password: string;
  mfaCode?: string;
  accountId?: string;
}, options: { userAgent?: string | null } = {}): Promise<NewSession> {
  const email = normalizeEmail(input.email);
  await enforceAuthRateLimit('login', email);
  const users = await getAuthPrisma().$queryRaw<
    Identity[]
  >`SELECT * FROM auth_users WHERE email=${email}`;
  const user = users[0];
  dummyPasswordHash ??= hashPassword(`Aa1!${randomToken()}`);
  const valid = await verifyPassword(
    user?.password_hash ?? (await dummyPasswordHash),
    input.password
  );
  if (!user || !valid || user.disabled_at)
    throw new UnauthorizedError('Invalid email or password');
  if (!user.email_verified_at)
    throw new AuthError(
      'Verify your email before signing in',
      403,
      'email_unverified'
    );
  return issueSession(user.id, {
    method: 'password',
    accountId: input.accountId,
    mfaCode: input.mfaCode,
    userAgent: options.userAgent,
    expectedPasswordHash: user.password_hash,
  });
}
export type SignInMethod = 'password' | 'google';
export interface IssueSessionOptions {
  method: SignInMethod;
  mfaCode?: string;
  userAgent?: string | null;
  /** Pick this membership instead of the last-used (else oldest) one. */
  accountId?: string;
  /** Password sign-in: refuse when the password changed after it was verified. */
  expectedPasswordHash?: string;
  /** Written to audit_logs with the new session id. */
  auditAction?: string;
  /** Errors for a user that cannot sign in and for a user without the membership. */
  refuseUser?: () => Error;
  refuseWorkspace?: () => Error;
}
/** Locks the user, picks the membership, enforces MFA and creates the session (password and Google sign-in). */
export async function issueSession(
  userId: string,
  options: IssueSessionOptions
): Promise<NewSession> {
  const sessionId = randomUUID(),
    refreshToken = randomToken(),
    csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  const accountId = await getAuthPrisma().$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      Identity[]
    >`SELECT * FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
    if (
      !locked[0] ||
      locked[0].disabled_at ||
      !locked[0].email_verified_at ||
      (options.expectedPasswordHash !== undefined &&
        locked[0].password_hash !== options.expectedPasswordHash)
    )
      throw options.refuseUser?.() ?? new UnauthorizedError('Sign in again');
    // Without a requested workspace, return to the one the latest session ended in (a tenant
    // switch moves the session), while the person is still a member; else the oldest membership.
    const memberships = await tx.$queryRaw<
      { account_id: string }[]
    >`SELECT m.account_id FROM account_memberships m
      LEFT JOIN LATERAL (SELECT s.account_id FROM auth_sessions s WHERE s.user_id=${userId}::uuid
        ORDER BY s.created_at DESC LIMIT 1) last ON last.account_id=m.account_id
      WHERE m.user_id=${userId}::uuid ORDER BY (last.account_id IS NULL), m.created_at`;
    // A verified identity with no membership left (removed from its only workspace, or its
    // invitation was used up before it verified) gets a personal workspace instead of a lockout.
    if (!memberships[0] && !options.accountId)
      memberships.push({
        account_id: await createPersonalWorkspace(tx, {
          id: userId,
          fullName: locked[0].full_name,
          email: locked[0].email,
        }),
      });
    const membership = options.accountId
      ? memberships.find((m) => m.account_id === options.accountId)
      : memberships[0];
    if (!membership)
      throw options.refuseWorkspace?.() ?? new AuthError('No workspace membership', 403);
    const mfaVerified = await checkMfa(tx, userId, options.mfaCode);
    await tx.$executeRaw`INSERT INTO auth_sessions(id,user_id,account_id,csrf_hash,expires_at,mfa_verified_at,user_agent,sign_in_method)
      VALUES(${sessionId}::uuid,${userId}::uuid,${membership.account_id}::uuid,${hashToken(csrfToken)},${expiresAt},${mfaVerified ? new Date() : null},${storableUserAgent(options.userAgent)},${options.method})`;
    await tx.$executeRaw`INSERT INTO auth_refresh_tokens(id,session_id,token_hash,expires_at) VALUES(${randomUUID()}::uuid,${sessionId}::uuid,${hashToken(refreshToken)},${expiresAt})`;
    if (options.auditAction)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${membership.account_id}::uuid,${userId}::uuid,${options.auditAction},${sessionId},'{}'::jsonb)`;
    return membership.account_id;
  });
  return {
    accessToken: await signAccessToken({ userId, accountId, sessionId }),
    refreshToken,
    csrfToken,
    expiresAt,
    sessionId,
  };
}
export async function rotateRefreshToken(
  token: string,
  request: Request,
  tokenClient = false
): Promise<IssuedSession> {
  if (!tokenClient) assertOrigin(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedError();
  const refreshToken = randomToken(),
    replacementId = randomUUID();
  const result = await getAuthPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        session_id: string;
        consumed_at: Date | null;
        expires_at: Date;
        user_id: string;
        account_id: string;
        csrf_hash: string;
        revoked_at: Date | null;
        session_expires_at: Date;
      }[]
    >`
      SELECT r.id,r.session_id,r.consumed_at,r.expires_at,s.user_id,s.account_id,s.csrf_hash,s.revoked_at,s.expires_at AS session_expires_at
      FROM auth_refresh_tokens r JOIN auth_sessions s ON s.id=r.session_id WHERE r.token_hash=${hashToken(token)} FOR UPDATE OF s,r`;
    const row = rows[0];
    if (!row) return null;
    assertCsrf(request, row.csrf_hash);
    if (row.consumed_at) {
      // Return the failure after commit: throwing here would roll back this revocation.
      await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=${row.session_id}::uuid`;
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${row.account_id}::uuid,${row.user_id}::uuid,'auth.refresh_reuse',${row.session_id},'{}'::jsonb)`;
      return null;
    }
    if (
      row.revoked_at ||
      row.expires_at <= new Date() ||
      row.session_expires_at <= new Date()
    )
      return null;
    const identity = await tx.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM auth_users u JOIN account_memberships m ON m.user_id=u.id AND m.account_id=${row.account_id}::uuid
      WHERE u.id=${row.user_id}::uuid AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
        AND (NOT EXISTS(SELECT 1 FROM auth_mfa_factors f WHERE f.user_id=u.id AND f.verified_at IS NOT NULL)
          OR EXISTS(SELECT 1 FROM auth_sessions s WHERE s.id=${row.session_id}::uuid AND s.mfa_verified_at IS NOT NULL))`;
    if (!identity[0]) return null;
    await tx.$executeRaw`INSERT INTO auth_refresh_tokens(id,session_id,token_hash,expires_at) VALUES(${replacementId}::uuid,${row.session_id}::uuid,${hashToken(refreshToken)},${row.session_expires_at})`;
    await tx.$executeRaw`UPDATE auth_refresh_tokens SET consumed_at=NOW(),replacement_id=${replacementId}::uuid WHERE id=${row.id}::uuid`;
    return row;
  });
  if (!result) throw new UnauthorizedError('Session expired. Sign in again.');
  return {
    accessToken: await signAccessToken({
      userId: result.user_id,
      accountId: result.account_id,
      sessionId: result.session_id,
    }),
    refreshToken,
    csrfToken: request.headers.get('x-csrf-token')!,
    expiresAt: result.session_expires_at,
  };
}
export async function switchTenant(
  context: AuthContext,
  accountId: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const expiresAt = await getAuthPrisma().$transaction(async (tx) => {
    const sessions = await tx.$queryRaw<
      { expires_at: Date }[]
    >`SELECT expires_at FROM auth_sessions WHERE id=${context.sessionId}::uuid
      AND user_id=${context.userId}::uuid AND account_id=${context.accountId}::uuid AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE`;
    if (!sessions[0]) throw new UnauthorizedError();
    const memberships = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM account_memberships WHERE account_id=${accountId}::uuid AND user_id=${context.userId}::uuid`;
    if (!memberships[0])
      throw new AuthError('No membership in the selected workspace', 403);
    await tx.$executeRaw`UPDATE auth_sessions SET account_id=${accountId}::uuid WHERE id=${context.sessionId}::uuid`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${accountId}::uuid,${context.userId}::uuid,'auth.tenant_switch',${context.sessionId},'{}'::jsonb)`;
    return sessions[0].expires_at;
  });
  return {
    accessToken: await signAccessToken({
      userId: context.userId,
      accountId,
      sessionId: context.sessionId,
    }),
    expiresAt,
  };
}
export async function revokeSessions(
  context: AuthContext,
  all = false
): Promise<void> {
  if (all)
    await getAuthPrisma()
      .$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${context.userId}::uuid`;
  else
    await getAuthPrisma()
      .$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=${context.sessionId}::uuid AND user_id=${context.userId}::uuid`;
}
export async function requestEmail(input: {
  email: string;
  purpose: 'reset' | 'verify';
  next?: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  await enforceAuthRateLimit(input.purpose, email, 5, 3600);
  emailTransport();
  const users = await getAuthPrisma().$queryRaw<
    Identity[]
  >`SELECT * FROM auth_users WHERE email=${email} AND disabled_at IS NULL`;
  const user = users[0];
  if (
    !user ||
    (input.purpose === 'verify' && user.email_verified_at) ||
    (input.purpose === 'reset' && !user.email_verified_at)
  )
    return;
  await sendVerification(
    email,
    await createVerification(user.id, input.purpose),
    input.purpose,
    input.next
  );
}
export async function requestEmailChange(
  context: AuthContext,
  newAddress: string,
  currentPassword: string,
  mfaCode?: string
): Promise<void> {
  const newEmail = normalizeEmail(newAddress);
  await enforceAuthRateLimit('email-change', context.userId, 5, 3600);
  emailTransport();
  const token = randomToken();
  const oldEmail = await getAuthPrisma().$transaction(async (tx) => {
    const users = await tx.$queryRaw<
      Identity[]
    >`SELECT * FROM auth_users WHERE id=${context.userId}::uuid AND disabled_at IS NULL FOR UPDATE`;
    const user = users[0];
    if (!user || !(await verifyPassword(user.password_hash, currentPassword)))
      throw new AuthError(
        'Current password is incorrect',
        401,
        'current_password_invalid'
      );
    await checkMfa(tx, context.userId, mfaCode);
    if (newEmail === user.email) return null;
    const existing = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM auth_users WHERE email=${newEmail}`;
    if (existing[0])
      throw new AuthError('Unable to use that email address', 400);
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${context.userId}::uuid AND purpose='change_email' AND consumed_at IS NULL`;
    await tx.$executeRaw`INSERT INTO auth_verifications(id,user_id,purpose,token_hash,expires_at,metadata)
      VALUES(${randomUUID()}::uuid,${context.userId}::uuid,'change_email',${hashToken(token)},${new Date(Date.now() + 3600000)},${JSON.stringify({ newEmail, oldEmail: user.email })}::jsonb)`;
    return user.email;
  });
  if (!oldEmail) return;
  const link = new URL('/auth/callback', appOrigin());
  link.searchParams.set('token', token);
  link.searchParams.set('purpose', 'change_email');
  await sendAuthEmail({
    from: process.env.AUTH_EMAIL_FROM,
    to: newEmail,
    subject: 'Confirm your new Bodhinox email',
    text: `Confirm your new email address: ${link.toString()}\nThis link expires in one hour. Your current email stays active until you confirm.`,
  });
  await emailTransport().sendMail({
    from: process.env.AUTH_EMAIL_FROM,
    to: oldEmail,
    subject: 'Bodhinox email change requested',
    text: `A change of your Bodhinox email address to ${newEmail} was requested. If you did not request it, reset your password immediately; this cancels pending email changes.`,
  });
}
export async function confirmEmailChange(token: string): Promise<void> {
  const success = await getAuthPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        email: string;
        metadata: { newEmail?: string; oldEmail?: string };
      }[]
    >`
      SELECT v.id,v.user_id,v.metadata,u.email FROM auth_verifications v JOIN auth_users u ON u.id=v.user_id
      WHERE v.token_hash=${hashToken(token)} AND v.purpose='change_email' AND v.consumed_at IS NULL AND v.expires_at>NOW() AND u.disabled_at IS NULL FOR UPDATE OF u,v`;
    const row = rows[0];
    if (!row || !row.metadata.newEmail || row.metadata.oldEmail !== row.email)
      return false;
    const newEmail = normalizeEmail(row.metadata.newEmail);
    await tx.$executeRaw`UPDATE auth_users SET email=${newEmail},email_verified_at=NOW() WHERE id=${row.user_id}::uuid`;
    await tx.$executeRaw`UPDATE profiles SET email=${newEmail},updated_at=NOW() WHERE user_id=${row.user_id}::uuid`;
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${row.user_id}::uuid AND consumed_at IS NULL`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${row.user_id}::uuid`;
    await tx.$executeRaw`INSERT INTO audit_logs(user_id,action,resource_id,metadata) VALUES(${row.user_id}::uuid,'auth.email_changed',${row.id},'{}'::jsonb)`;
    return true;
  });
  if (!success)
    throw new AuthError('This link is invalid or expired', 400, 'link_invalid');
}
type VerifyMetadata = {
  inviteTokenHash?: unknown;
  passwordHash?: unknown;
  fullName?: unknown;
  termsVersion?: unknown;
};
/** Whether an emailed verify link can still be used (the /verify-email form asks for the password). */
export async function isVerifyTokenValid(token: string): Promise<boolean> {
  const rows = await getAuthPrisma().$queryRaw<{ id: string }[]>`
    SELECT v.id FROM auth_verifications v JOIN auth_users u ON u.id=v.user_id WHERE v.token_hash=${hashToken(token)}
      AND v.purpose='verify' AND v.consumed_at IS NULL AND v.expires_at>NOW() AND u.disabled_at IS NULL AND u.email_verified_at IS NULL`;
  return !!rows[0];
}
/**
 * Proves the email with the emailed link AND the password of one of the pending signups for that
 * address. The link proves the inbox; the password picks which signup the inbox owner made, so a
 * stranger who signed up first with someone else's address (account pre-hijack) never keeps the
 * password, and a stranger's later signup cannot replace the owner's either. The chosen signup's
 * password, name and terms become the account's; every other pending link dies with it.
 */
export async function verifyEmailToken(token: string, password: string): Promise<void> {
  const result = await getAuthPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        user_id: string;
        id: string;
        full_name: string;
        email: string;
        password_hash: string;
        metadata: VerifyMetadata;
      }[]
    >`
      SELECT v.id,v.user_id,v.metadata,u.full_name,u.email,u.password_hash FROM auth_verifications v JOIN auth_users u ON u.id=v.user_id
      WHERE v.token_hash=${hashToken(token)} AND v.purpose='verify' AND v.consumed_at IS NULL AND v.expires_at>NOW()
        AND u.disabled_at IS NULL AND u.email_verified_at IS NULL FOR UPDATE OF v,u`;
    const row = rows[0];
    if (!row) return 'invalid' as const;
    const pending = await tx.$queryRaw<{ id: string; metadata: VerifyMetadata }[]>`
      SELECT id,metadata FROM auth_verifications WHERE user_id=${row.user_id}::uuid AND purpose='verify'
        AND consumed_at IS NULL AND expires_at>NOW() ORDER BY expires_at DESC FOR UPDATE`;
    let chosen: VerifyMetadata | null = null;
    for (const candidate of pending) {
      const hash = candidate.metadata?.passwordHash;
      if (typeof hash === 'string' && (await verifyPassword(hash, password))) {
        chosen = candidate.metadata;
        break;
      }
    }
    // Links from before this check (or a plain resend) carry no password: the account's own
    // password must match, with the clicked link's invitation.
    if (!chosen && (await verifyPassword(row.password_hash, password)))
      chosen = { ...row.metadata, passwordHash: undefined };
    if (!chosen) return 'mismatch' as const;
    const fullName =
      typeof chosen.fullName === 'string' && chosen.fullName ? chosen.fullName : row.full_name;
    const terms = typeof chosen.termsVersion === 'string' ? chosen.termsVersion : null;
    await tx.$executeRaw`UPDATE auth_users SET email_verified_at=NOW(),full_name=${fullName},
        password_hash=${typeof chosen.passwordHash === 'string' ? chosen.passwordHash : row.password_hash},password_set=true,
        terms_version=COALESCE(${terms},terms_version),terms_accepted_at=CASE WHEN ${terms}::text IS NULL THEN terms_accepted_at ELSE NOW() END
      WHERE id=${row.user_id}::uuid`;
    await tx.$executeRaw`UPDATE profiles SET full_name=${fullName},updated_at=NOW() WHERE user_id=${row.user_id}::uuid`;
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${row.user_id}::uuid AND purpose='verify' AND consumed_at IS NULL`;
    // Nothing should hold a session, second factor or linked sign-in on a row that was never
    // verified; clear them defensively so nothing set up by an earlier signer survives.
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${row.user_id}::uuid`;
    await tx.$executeRaw`DELETE FROM auth_mfa_factors WHERE user_id=${row.user_id}::uuid`;
    await tx.$executeRaw`DELETE FROM auth_identities WHERE user_id=${row.user_id}::uuid`;
    // Invited signup: join now that the address is proven. A link used or expired meanwhile is
    // skipped; sign-in then falls back to a personal workspace.
    const inviteHash = chosen.inviteTokenHash;
    const invite =
      typeof inviteHash === 'string'
        ? await lockInvitationByHash(tx, inviteHash)
        : null;
    if (invite)
      await joinInvitedWorkspace(tx, invite, {
        id: row.user_id,
        fullName,
        email: row.email,
      });
    return 'verified' as const;
  });
  if (result === 'invalid')
    throw new AuthError('This link is invalid or expired', 400, 'link_invalid');
  if (result === 'mismatch')
    throw new AuthError(
      'Enter the password you chose when you signed up with this email',
      400,
      'password_mismatch'
    );
}
export async function isRecoveryTokenValid(token: string): Promise<boolean> {
  const rows = await getAuthPrisma().$queryRaw<{ id: string }[]>`
    SELECT v.id FROM auth_verifications v JOIN auth_users u ON u.id=v.user_id WHERE token_hash=${hashToken(token)}
      AND purpose='reset' AND consumed_at IS NULL AND expires_at>NOW() AND u.disabled_at IS NULL`;
  return !!rows[0];
}
export async function resetPassword(
  token: string,
  password: string,
  mfaCode?: string
): Promise<void> {
  const passwordHash = await hashPassword(password);
  const result = await getAuthPrisma().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ user_id: string; id: string }[]>`
      SELECT v.id,v.user_id FROM auth_verifications v JOIN auth_users u ON u.id=v.user_id
      WHERE v.token_hash=${hashToken(token)} AND v.purpose='reset' AND v.consumed_at IS NULL AND v.expires_at>NOW() AND u.disabled_at IS NULL FOR UPDATE OF u,v`;
    if (!rows[0]) return false;
    await checkMfa(tx, rows[0].user_id, mfaCode);
    await tx.$executeRaw`UPDATE auth_users SET password_hash=${passwordHash},password_set=true WHERE id=${rows[0].user_id}::uuid`;
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${rows[0].user_id}::uuid AND purpose IN ('reset','change_email') AND consumed_at IS NULL`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${rows[0].user_id}::uuid`;
    return true;
  });
  if (!result)
    throw new AuthError('This link is invalid or expired', 400, 'link_invalid');
}
export async function updatePassword(
  context: AuthContext,
  password: string,
  currentPassword: string,
  mfaCode?: string
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await getAuthPrisma().$transaction(async (tx) => {
    const users = await tx.$queryRaw<
      Identity[]
    >`SELECT * FROM auth_users WHERE id=${context.userId}::uuid FOR UPDATE`;
    if (
      !users[0] ||
      !(await verifyPassword(users[0].password_hash, currentPassword))
    )
      throw new AuthError(
        'Current password is incorrect',
        401,
        'current_password_invalid'
      );
    await checkMfa(tx, context.userId, mfaCode);
    await tx.$executeRaw`UPDATE auth_users SET password_hash=${passwordHash},password_set=true WHERE id=${context.userId}::uuid`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=NOW() WHERE user_id=${context.userId}::uuid AND purpose IN ('reset','change_email') AND consumed_at IS NULL`;
  });
}
