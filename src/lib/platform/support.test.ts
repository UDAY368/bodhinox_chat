import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@/lib/auth/errors';
import {
  createProactiveGrant, parseGrantDecision, parseProactiveGrant, parseSupportRequest, SupportGrantError, supportErrorResponse,
} from './support';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

describe('support request and grant bodies', () => {
  it('accepts a platform request with a reason and a 15..1440 minute window only', () => {
    expect(parseSupportRequest({ accountId: ACCOUNT.toUpperCase(), reason: '  Customer reports failures ', minutes: 60 }))
      .toEqual({ accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60 });
    for (const bad of [
      { accountId: 'x', reason: 'Customer reports failures', minutes: 60 },
      { accountId: ACCOUNT, reason: 'short', minutes: 60 },
      { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 14 },
      { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 1441 },
      { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60.5 },
      { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60, scope: 'content' },
      null, [], 'text',
    ]) expect(parseSupportRequest(bad)).toBeNull();
  });

  it('accepts approve (optional window), deny and revoke decisions only', () => {
    expect(parseGrantDecision({ action: 'approve' })).toEqual({ action: 'approve', minutes: null });
    expect(parseGrantDecision({ action: 'approve', minutes: 30 })).toEqual({ action: 'approve', minutes: 30 });
    expect(parseGrantDecision({ action: 'deny' })).toEqual({ action: 'deny' });
    expect(parseGrantDecision({ action: 'revoke' })).toEqual({ action: 'revoke' });
    for (const bad of [{ action: 'approve', minutes: 5 }, { action: 'deny', minutes: 30 }, { action: 'extend' }, { action: 'approve', status: 'x' }, null])
      expect(parseGrantDecision(bad)).toBeNull();
  });

  it('accepts a proactive grant for a well-formed email with a reason', () => {
    expect(parseProactiveGrant({ email: ' Ops@Bodhinox.Test ', reason: 'Please check our webhooks', minutes: 240 }))
      .toEqual({ email: 'ops@bodhinox.test', reason: 'Please check our webhooks', minutes: 240 });
    expect(parseProactiveGrant({ email: 'not-an-email', reason: 'Please check our webhooks', minutes: 240 })).toBeNull();
    expect(parseProactiveGrant({ email: 'ops@bodhinox.test', reason: 'short', minutes: 240 })).toBeNull();
  });

  it('answers a proactive grant the same way whether or not the email is a platform admin (no allowlist probing)', async () => {
    const outcome = async (email: string) => {
      const row = { id: 'g1', requested_by_email: email, reason: 'Please check our webhooks', requested_minutes: 60, status: 'approved',
        requested_at: new Date(), decided_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), revoked_at: null, decided_by: ACCOUNT };
      const tx = { $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async (sql: TemplateStringsArray) => (sql.join('?').includes('INSERT INTO support_grants') ? [{ id: 'g1' }] : [row])) };
      const grant = await createProactiveGrant(tx as never, { accountId: ACCOUNT, userId: ACCOUNT }, { email, reason: 'Please check our webhooks', minutes: 60 });
      return { status: grant.status, inserts: tx.$queryRaw.mock.calls.length };
    };
    process.env.PLATFORM_ADMIN_EMAILS = 'ops@bodhinox.test';
    expect(await outcome('someone@example.com')).toEqual(await outcome('ops@bodhinox.test'));
  });

  it('maps refusals to { error, code } and hides unexpected errors', async () => {
    const refused = supportErrorResponse(new SupportGrantError('grant_open'));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'grant_open', code: 'grant_open' });
    expect(supportErrorResponse(new AuthError('Insufficient workspace role', 403, 'forbidden')).status).toBe(403);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = supportErrorResponse(new Error('connection string postgres://secret'));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    log.mockRestore();
  });
});
