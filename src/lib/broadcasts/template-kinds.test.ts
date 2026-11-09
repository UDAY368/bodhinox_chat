/**
 * Campaign creation, campaign test sends and API campaigns with the new
 * template kinds: authentication templates are refused, and the values
 * a campaign fixes for every recipient are checked and stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';

/** The transaction stub answers each statement by what its SQL starts with. */
const db = vi.hoisted(() => ({
  template: null as unknown,
  statements: [] as { sql: string; values: unknown[] }[],
}));
function sqlOf(first: unknown): string {
  if (Array.isArray(first)) return first.join('?');
  const sql = first as { strings?: string[] } | undefined;
  return sql?.strings?.join('?') ?? '';
}
const tx = {
  $queryRaw: async (first: unknown, ...values: unknown[]) => {
    const sql = sqlOf(first);
    db.statements.push({ sql, values });
    if (sql.includes('FROM account_memberships')) return [{ role: 'agent' }];
    if (sql.includes('FROM message_templates')) return db.template ? [db.template] : [];
    if (sql.includes('count(*)::int AS matched')) return [{ matched: 2 }];
    if (sql.includes('INSERT INTO broadcasts')) return [{ id: 'b-1' }];
    if (sql.includes('length(p)>1024')) return [{ found: false }];
    return [];
  },
  $executeRaw: async (first: unknown, ...values: unknown[]) => {
    db.statements.push({ sql: sqlOf(first), values });
    return 2;
  },
};
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_scope: unknown, operation: (t: typeof tx) => Promise<unknown>) => operation(tx),
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/billing/entitlements', () => ({
  requireFeature: async () => {},
  requireWithinLimit: async () => {},
  PlanLimitError: class extends Error {},
}));
vi.mock('@/lib/billing/limits', () => ({ requireCampaignSendRoom: async () => {} }));

import { createCampaign } from './create-campaign';
import { sendCampaignTest } from './test-send';
import { createApiCampaign } from './api-campaign';

const SCOPE = { accountId: '00000000-0000-4000-8000-0000000000a1', userId: '00000000-0000-4000-8000-0000000000b1', role: 'agent' as const };
const TEMPLATE_ID = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-11-02T12:00:00Z');

function tpl(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: TEMPLATE_ID, user_id: SCOPE.userId, name: 'kinds', category: 'Marketing', language: 'en_US',
    body_text: 'Hi {{1}}', status: 'APPROVED', buttons: [], created_at: '2026-01-01T00:00:00Z', ...over,
  };
}
const AUTH = tpl({ category: 'Authentication', template_kind: 'authentication', body_text: '' });
const OFFER = tpl({
  template_kind: 'limited_time_offer',
  lto: { text: 'Ends soon', has_expiration: true },
  buttons: [{ type: 'COPY_CODE', text: 'Copy', example: 'SAVE10' }],
});
const CAROUSEL = tpl({
  template_kind: 'carousel',
  cards: [
    { header_type: 'image', header_media_url: 'https://cdn.test/a.png', body_text: 'A {{1}}', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
    { header_type: 'image', header_media_url: 'https://cdn.test/b.png', body_text: 'B', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
  ],
});
const name = { type: 'field' as const, value: 'name' as const };
/** The translated refusal (or its key path while the catalogue merge is pending). */
const AUTH_REFUSAL = expect.stringMatching(/authOnlyInbox|inbox/);

function campaign(extra: Record<string, unknown>) {
  return { name: 'Kinds', templateId: TEMPLATE_ID, audience: { type: 'all' }, variables: { 1: name }, ...extra };
}
function storedVariables(): Record<string, unknown> {
  const insert = db.statements.find((s) => s.sql.includes('INSERT INTO broadcasts'))!;
  return JSON.parse(insert.values.find((v) => typeof v === 'string' && v.includes('"1"')) as string);
}

beforeEach(() => {
  db.statements = [];
  db.template = null;
});

describe('campaign creation', () => {
  it('refuses an authentication template', async () => {
    db.template = AUTH;
    await expect(createCampaign(SCOPE, campaign({ variables: {} }), NOW)).rejects.toMatchObject({ status: 400, message: AUTH_REFUSAL });
    expect(db.statements.some((s) => s.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('requires the offer end and refuses one before sending starts', async () => {
    db.template = OFFER;
    await expect(createCampaign(SCOPE, campaign({}), NOW)).rejects.toMatchObject({ status: 400 });
    await expect(
      createCampaign(SCOPE, campaign({ sendExtras: { offerExpirationTimeMs: NOW.getTime() - 1 } }), NOW),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.statements.some((s) => s.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('stores the extras beside the mappings so every pass reuses them', async () => {
    db.template = OFFER;
    const ends = NOW.getTime() + 86_400_000;
    await createCampaign(SCOPE, campaign({ sendExtras: { offerExpirationTimeMs: ends, couponCode: 'VIP5' } }), NOW);
    expect(storedVariables()).toEqual({ 1: name, _send: { offerExpirationTimeMs: ends, couponCode: 'VIP5' } });
  });

  it('maps carousel card variables after the body variables', async () => {
    db.template = CAROUSEL;
    await expect(createCampaign(SCOPE, campaign({}), NOW)).rejects.toMatchObject({ status: 400 });
    await createCampaign(SCOPE, campaign({ variables: { 1: name, c1_1: { type: 'static', value: 'Blue' } } }), NOW);
    expect(storedVariables()).toEqual({ 1: name, c1_1: { type: 'static', value: 'Blue' } });
  });

  it('keeps a standard campaign unchanged', async () => {
    db.template = tpl({});
    await createCampaign(SCOPE, campaign({}), NOW);
    expect(storedVariables()).toEqual({ 1: name });
  });
});

describe('campaign test send and API campaigns', () => {
  it('refuses an authentication template for a test send', async () => {
    db.template = AUTH;
    await expect(
      sendCampaignTest(SCOPE, { templateId: TEMPLATE_ID, phones: ['+14155550101'], variables: {} }),
    ).rejects.toMatchObject({ status: 400, message: AUTH_REFUSAL });
  });

  it('refuses an authentication template for an API campaign', async () => {
    db.template = AUTH;
    await expect(createApiCampaign(SCOPE, { name: 'OTP', templateId: TEMPLATE_ID })).rejects.toMatchObject({
      status: 400,
      code: 'template_kind_not_allowed',
    });
  });
});
