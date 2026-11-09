// account_update webhook: which Meta events disconnect a number, which only warn,
// which clear a warning, and that only Meta enum values reach the stored detail.
// Payloads follow Meta's account_update reference examples.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apply: vi.fn(), resolveWaba: vi.fn(), resolvePhone: vi.fn() }));
vi.mock('@/lib/repositories/routing', () => ({ resolveWhatsAppAccount: h.resolvePhone, resolveWabaAccount: h.resolveWaba }));
vi.mock('@/lib/whatsapp/account-update', async (original) => ({
  ...(await original<typeof import('./account-update')>()),
  applyAccountUpdate: h.apply,
}));

import { accountIssue } from './account-issue';
import { ourMetaAppIds, parseAccountUpdate } from './account-update';
import { processWebhook } from './process-webhook';

const WABA = '102290129340398';
const PARTNER = '2949482758682047';
const TIME = 1_762_700_000;
const parse = (value: unknown, entryId = WABA) => parseAccountUpdate(entryId, TIME, value, ['869361281603019']);

describe('parseAccountUpdate', () => {
  it('disconnects on partner removal, our app uninstalled, deletion and a ban', () => {
    expect(parse({ event: 'PARTNER_REMOVED', waba_info: { waba_id: '980198427658004', owner_business_id: '1' } }, PARTNER))
      .toMatchObject({ wabaId: '980198427658004', event: 'PARTNER_REMOVED', action: 'remove', detail: null, at: new Date(TIME * 1000) });
    expect(parse({ event: 'PARTNER_REMOVED', waba_info: { waba_id: '980198427658004' }, disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } }, PARTNER)?.detail)
      .toBe('PRIMARY_INACTIVITY, SYSTEM');
    expect(parse({ event: 'PARTNER_APP_UNINSTALLED', waba_info: { waba_id: '184943124712545', partner_app_id: '869361281603019' } }, PARTNER))
      .toMatchObject({ wabaId: '184943124712545', action: 'remove' });
    expect(parse({ event: 'ACCOUNT_DELETED' })).toMatchObject({ wabaId: WABA, action: 'remove' });
    expect(parse({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE', waba_ban_date: 'April 17, 2025' } }))
      .toMatchObject({ action: 'remove', detail: 'DISABLE' });
  });

  it('ignores another partner app being uninstalled from the same account', () => {
    expect(parse({ event: 'PARTNER_APP_UNINSTALLED', waba_info: { waba_id: '184943124712545', partner_app_id: '555' } }, PARTNER)).toBeNull();
  });

  it('warns on restrictions, violations, a scheduled ban and offboarding, keeping the latest expiry', () => {
    const restriction = parse({ event: 'ACCOUNT_RESTRICTION', restriction_info: [
      { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1641330498 },
      { restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION', expiration: 1641330598 },
    ] });
    expect(restriction).toMatchObject({
      action: 'warn',
      detail: 'RESTRICTED_BIZ_INITIATED_MESSAGING, RESTRICTED_ADD_PHONE_NUMBER_ACTION',
      until: new Date(1641330598 * 1000),
    });
    expect(parse({ event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'ADULT' } })).toMatchObject({ action: 'warn', detail: 'ADULT' });
    expect(parse({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' } })).toMatchObject({ action: 'warn' });
    expect(parse({ event: 'ACCOUNT_OFFBOARDED' })).toMatchObject({ action: 'warn' });
  });

  it('clears on reinstatement and reconnection; ignores unrelated or malformed events', () => {
    expect(parse({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } })).toMatchObject({ action: 'clear', detail: 'REINSTATE' });
    expect(parse({ event: 'ACCOUNT_RECONNECTED' })).toMatchObject({ action: 'clear' });
    expect(parse({ event: 'VOLUME_BASED_PRICING_TIER_UPDATE' })).toBeNull();
    expect(parse({ event: 'PARTNER_ADDED', waba_info: { waba_id: WABA } })).toBeNull();
    expect(parse({ event: 'lowercase' })).toBeNull();
    expect(parse({ event: 'ACCOUNT_DELETED' }, 'not-an-id')).toBeNull();
    expect(parse(null)).toBeNull();
  });

  it('never stores free text from the payload', () => {
    const update = parse({ event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'Customer +91 98765 43210 said hi' } });
    expect(update?.detail).toBeNull();
  });

  it('reads our app ids from the environment', () => {
    expect(ourMetaAppIds({ NEXT_PUBLIC_META_APP_ID: ' 123 ', META_APP_ID: 'abc' })).toEqual(['123']);
  });
});

describe('accountIssue', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    meta_account_event: 'ACCOUNT_RESTRICTION',
    meta_account_detail: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
    meta_account_event_at: new Date('2026-11-01T00:00:00Z'),
    meta_account_until: null as Date | null,
    connected_at: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });
  const now = new Date('2026-11-10T00:00:00Z');

  it('shows a current problem', () => {
    expect(accountIssue(row(), now)).toEqual({
      event: 'ACCOUNT_RESTRICTION', detail: 'RESTRICTED_BIZ_INITIATED_MESSAGING', at: '2026-11-01T00:00:00.000Z', until: null,
    });
  });

  it('hides an expired, cleared, unknown or superseded-by-reconnect event', () => {
    expect(accountIssue(row({ meta_account_until: new Date('2026-11-05T00:00:00Z') }), now)).toBeNull();
    expect(accountIssue(row({ meta_account_event: 'DISABLED_UPDATE', meta_account_detail: 'REINSTATE' }), now)).toBeNull();
    expect(accountIssue(row({ meta_account_event: 'ACCOUNT_RECONNECTED' }), now)).toBeNull();
    expect(accountIssue(row({ connected_at: new Date('2026-11-02T00:00:00Z') }), now)).toBeNull();
  });
});

describe('processWebhook routes account_update by WABA', () => {
  const body = (value: unknown, entryId = WABA) =>
    ({ entry: [{ id: entryId, time: TIME, changes: [{ field: 'account_update', value }] }] }) as unknown as Parameters<typeof processWebhook>[0];
  const ACCOUNT = '11111111-1111-4111-8111-111111111111';

  it('applies a known event to the workspace that owns the WABA', async () => {
    h.apply.mockReset();
    h.resolveWaba.mockReset();
    h.resolveWaba.mockResolvedValue(ACCOUNT);
    await processWebhook(body({ event: 'ACCOUNT_DELETED' }));
    expect(h.resolveWaba).toHaveBeenCalledWith(WABA);
    expect(h.apply).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ wabaId: WABA, action: 'remove' }));
    expect(h.resolvePhone).not.toHaveBeenCalled();
  });

  it('skips an unknown WABA or an ignored event without touching anything', async () => {
    h.apply.mockReset();
    h.resolveWaba.mockReset();
    h.resolveWaba.mockResolvedValue(null);
    await processWebhook(body({ event: 'ACCOUNT_DELETED' }));
    await processWebhook(body({ event: 'VOLUME_BASED_PRICING_TIER_UPDATE' }));
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.resolveWaba).toHaveBeenCalledTimes(1);
  });
});
