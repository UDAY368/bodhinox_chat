/**
 * Store plan Phase 8, batch 6: email campaigns to shop customers (admins; agents read).
 *
 * An audience is a saved segment (the shop filters are part of the segment system, lib/audience/filter.ts) or every contact. Only
 * contacts with an email address and recorded email consent who have not unsubscribed can receive one (emailRefusal); the
 * consent is recorded by an admin who attests the customer agreed (recordEmailConsent), and an unsubscribe is final.
 *
 * Sending (sendCampaign) is one transaction on the app role (RLS: admins only): it freezes the text, snapshots the recipients and
 * queues one job per recipient (key emailc:<campaign>:<contact>, spread at EMAIL_LIMITS.perMinute a minute), and only then answers.
 * Calling it again finds the same recipients and queues only the jobs that are missing. The jobs (email-campaign-jobs.ts) check
 * consent again at send time and send through dispatchOnce, so a replayed job never sends twice and an uncertain send is shown
 * as "unknown", never retried. Logs carry ids only.
 */
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { compileAudienceFilter } from '@/lib/audience/filter';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { type CampaignInput, EMAIL_LIMITS } from './email-rules';
import { emailConnected } from './email-send';
import { loadMarketingSettingsTx } from './marketing-settings';
import { auditStoreChange, isUuid, StoreError } from './store-settings';

export const EMAIL_SEND_JOB = 'shop.email_send';

type Staff = TenantContext & { userId: string };

export interface CampaignView {
  id: string;
  name: string;
  subject: string;
  body: string;
  segment_id: string | null;
  segment_name: string | null;
  status: 'draft' | 'sending' | 'cancelled';
  recipient_count: number;
  created_at: string;
  queued_at: string | null;
  counts: Record<'queued' | 'sending' | 'sent' | 'skipped' | 'failed' | 'unknown', number>;
}

interface CampaignRow {
  id: string; name: string; subject: string; body: string; segment_id: string | null; segment_name: string | null; status: CampaignView['status'];
  recipient_count: number; created_at: Date; queued_at: Date | null;
  queued: number; sending: number; sent: number; skipped: number; failed: number; unknown: number;
}

const view = (r: CampaignRow): CampaignView => ({
  id: r.id, name: r.name, subject: r.subject, body: r.body, segment_id: r.segment_id, segment_name: r.segment_name, status: r.status,
  recipient_count: r.recipient_count, created_at: r.created_at.toISOString(), queued_at: r.queued_at?.toISOString() ?? null,
  counts: { queued: r.queued, sending: r.sending, sent: r.sent, skipped: r.skipped, failed: r.failed, unknown: r.unknown },
});

const SELECT = Prisma.sql`SELECT c.id::text AS id, c.name, c.subject, c.body, c.segment_id::text AS segment_id, s.name AS segment_name, c.status,
    c.recipient_count, c.created_at, c.queued_at,
    count(r.*) FILTER (WHERE r.status='queued')::int AS queued, count(r.*) FILTER (WHERE r.status='sending')::int AS sending,
    count(r.*) FILTER (WHERE r.status='sent')::int AS sent, count(r.*) FILTER (WHERE r.status='skipped')::int AS skipped,
    count(r.*) FILTER (WHERE r.status='failed')::int AS failed, count(r.*) FILTER (WHERE r.status='unknown')::int AS unknown
  FROM shop_email_campaigns c LEFT JOIN segments s ON s.account_id=c.account_id AND s.id=c.segment_id
  LEFT JOIN shop_email_recipients r ON r.account_id=c.account_id AND r.campaign_id=c.id`;

export function listCampaigns(ctx: TenantContext): Promise<CampaignView[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<CampaignRow[]>(Prisma.sql`${SELECT} WHERE c.account_id=${ctx.accountId}::uuid
      GROUP BY c.id, s.name ORDER BY c.created_at DESC LIMIT 100`);
    return rows.map(view);
  });
}

async function loadCampaignTx(tx: TenantTransaction, accountId: string, id: string): Promise<CampaignView | null> {
  const [row] = await tx.$queryRaw<CampaignRow[]>(Prisma.sql`${SELECT} WHERE c.account_id=${accountId}::uuid AND c.id=${id}::uuid GROUP BY c.id, s.name`);
  return row ? view(row) : null;
}

export function getCampaign(ctx: TenantContext, id: string): Promise<CampaignView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    const found = await loadCampaignTx(tx, ctx.accountId, id);
    if (!found) throw new StoreError('not_found');
    return found;
  });
}

async function assertSegment(tx: TenantTransaction, accountId: string, segmentId: string | null): Promise<void> {
  if (!segmentId) return;
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM segments WHERE account_id=${accountId}::uuid AND id=${segmentId}::uuid AND archived_at IS NULL`;
  if (!row) throw new StoreError('invalid', { field: 'segment_id' });
}

export async function createCampaign(ctx: Staff, input: CampaignInput): Promise<CampaignView> {
  return withTenant(ctx, async (tx) => {
    await assertSegment(tx, ctx.accountId, input.segmentId);
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_email_campaigns(account_id,name,subject,body,segment_id,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.subject},${input.body},${input.segmentId}::uuid,${ctx.userId}::uuid) RETURNING id::text AS id`;
    // The text is the seller's own words: it stays out of the audit trail.
    await auditStoreChange(tx, ctx, 'commerce.email_campaign_created', row.id, { segment: input.segmentId !== null });
    return (await loadCampaignTx(tx, ctx.accountId, row.id))!;
  });
}

/** Edit a draft. A campaign already queued cannot change (the table refuses it too). */
export async function updateCampaign(ctx: Staff, id: string, input: CampaignInput): Promise<CampaignView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    await assertSegment(tx, ctx.accountId, input.segmentId);
    const [cur] = await tx.$queryRaw<{ queued_at: Date | null }[]>`SELECT queued_at FROM shop_email_campaigns WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!cur) throw new StoreError('not_found');
    if (cur.queued_at) throw new StoreError('campaign_locked');
    await tx.$executeRaw`UPDATE shop_email_campaigns SET name=${input.name}, subject=${input.subject}, body=${input.body}, segment_id=${input.segmentId}::uuid
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    await auditStoreChange(tx, ctx, 'commerce.email_campaign_updated', id, { segment: input.segmentId !== null });
    return (await loadCampaignTx(tx, ctx.accountId, id))!;
  });
}

// ---------------------------------------------------------------------------
// Audience

/** Contacts of the audience (a segment's filter, or everyone) as a SQL condition over `contacts c`. */
async function audienceWhere(tx: TenantTransaction, accountId: string, segmentId: string | null): Promise<Prisma.Sql> {
  if (!segmentId) return Prisma.sql`c.account_id=${accountId}::uuid`;
  return compileAudienceFilter(accountId, await loadSegmentFilter(tx, accountId, segmentId));
}

const EMAIL_SQL = Prisma.sql`c.email ~ '^[^[:space:]@<>",;]{1,64}@[^[:space:]@<>",;]{1,255}$'`;

export interface AudiencePreview { audience: number; withEmail: number; eligible: number; unsubscribed: number }

/** How many contacts the audience has, how many have an email, and how many may be emailed now. */
export function previewCampaignAudience(ctx: TenantContext, segmentId: string | null): Promise<AudiencePreview> {
  return withTenant(ctx, async (tx) => {
    const where = await audienceWhere(tx, ctx.accountId, segmentId);
    const [row] = await tx.$queryRaw<{ audience: number; with_email: number; eligible: number; unsubscribed: number }[]>(Prisma.sql`
      SELECT count(*)::int AS audience, count(*) FILTER (WHERE ${EMAIL_SQL})::int AS with_email,
        count(*) FILTER (WHERE ${EMAIL_SQL} AND c.blocked_at IS NULL AND p.opted_in_at IS NOT NULL AND p.unsubscribed_at IS NULL)::int AS eligible,
        count(*) FILTER (WHERE p.unsubscribed_at IS NOT NULL)::int AS unsubscribed
      FROM contacts c LEFT JOIN shop_email_prefs p ON p.account_id=c.account_id AND p.contact_id=c.id WHERE ${where}`);
    return { audience: row.audience, withEmail: row.with_email, eligible: row.eligible, unsubscribed: row.unsubscribed };
  });
}

/**
 * An admin records that the customers of an audience agreed to marketing email (they attest it; their user id and the time are
 * kept). Only contacts with an email address; a contact who unsubscribed is never given consent again. Returns how many were
 * newly recorded.
 */
export async function recordEmailConsent(ctx: Staff, segmentId: string | null): Promise<{ recorded: number }> {
  return withTenant(ctx, async (tx) => {
    const where = await audienceWhere(tx, ctx.accountId, segmentId);
    const recorded = await tx.$executeRaw(Prisma.sql`
      INSERT INTO shop_email_prefs(account_id,contact_id,opted_in_at,opt_in_source,opted_in_by)
      SELECT c.account_id, c.id, now(), 'staff_attestation', ${ctx.userId}::uuid FROM contacts c WHERE ${where} AND ${EMAIL_SQL} AND c.blocked_at IS NULL
      ORDER BY c.id LIMIT ${EMAIL_LIMITS.recipients}
      ON CONFLICT (account_id, contact_id) DO UPDATE SET opted_in_at=EXCLUDED.opted_in_at, opt_in_source=EXCLUDED.opt_in_source, opted_in_by=EXCLUDED.opted_in_by
        WHERE shop_email_prefs.unsubscribed_at IS NULL AND shop_email_prefs.opted_in_at IS NULL`);
    await auditStoreChange(tx, ctx, 'commerce.email_consent_recorded', segmentId ?? ctx.accountId, { count: Number(recorded), segment: segmentId !== null });
    return { recorded: Number(recorded) };
  });
}

// ---------------------------------------------------------------------------
// Send and cancel

/** Queue the jobs of every recipient still waiting (a repeat finds the existing ones by key). */
async function queueJobsTx(tx: TenantTransaction, accountId: string, campaignId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    SELECT ${EMAIL_SEND_JOB}::text, r.account_id, jsonb_build_object('campaignId', r.campaign_id::text, 'contactId', r.contact_id::text),
      'emailc:' || r.campaign_id::text || ':' || r.contact_id::text,
      now() + ((row_number() OVER (ORDER BY r.id) - 1) / ${EMAIL_LIMITS.perMinute}::int) * interval '1 minute'
    FROM shop_email_recipients r WHERE r.account_id=${accountId}::uuid AND r.campaign_id=${campaignId}::uuid AND r.status='queued'
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/**
 * Send a campaign: refuses (nothing created) when email is not connected, the sender's postal address is not set, nobody can
 * receive it, or too many can (EMAIL_LIMITS.recipients). Repeating the call after it was queued only re-queues what is missing.
 */
export async function sendCampaign(ctx: Staff, id: string): Promise<CampaignView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    const [campaign] = await tx.$queryRaw<{ segment_id: string | null; status: string; queued_at: Date | null }[]>`
      SELECT segment_id::text AS segment_id, status, queued_at FROM shop_email_campaigns WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!campaign) throw new StoreError('not_found');
    if (campaign.status === 'cancelled') throw new StoreError('campaign_locked');
    if (!campaign.queued_at) {
      if (!emailConnected()) throw new StoreError('email_not_connected');
      const settings = await loadMarketingSettingsTx(tx, ctx.accountId);
      if (!settings.sender_address) throw new StoreError('sender_details_required');
      const where = await audienceWhere(tx, ctx.accountId, campaign.segment_id);
      const eligible = await tx.$queryRaw<{ contact_id: string; email: string }[]>(Prisma.sql`
        SELECT c.id::text AS contact_id, lower(btrim(c.email)) AS email FROM contacts c
        JOIN shop_email_prefs p ON p.account_id=c.account_id AND p.contact_id=c.id AND p.opted_in_at IS NOT NULL AND p.unsubscribed_at IS NULL
        WHERE ${where} AND ${EMAIL_SQL} AND c.blocked_at IS NULL ORDER BY c.id LIMIT ${EMAIL_LIMITS.recipients + 1}`);
      if (!eligible.length) throw new StoreError('no_recipients');
      if (eligible.length > EMAIL_LIMITS.recipients) throw new StoreError('too_many_recipients');
      await tx.$executeRaw`INSERT INTO shop_email_recipients(account_id,campaign_id,contact_id,email)
        SELECT ${ctx.accountId}::uuid, ${id}::uuid, x.contact_id::uuid, x.email
        FROM jsonb_to_recordset(${JSON.stringify(eligible)}::jsonb) AS x(contact_id text, email text) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`UPDATE shop_email_campaigns SET status='sending', queued_at=now(), recipient_count=${eligible.length}
        WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
      await auditStoreChange(tx, ctx, 'commerce.email_campaign_sent', id, { recipients: eligible.length });
    }
    await queueJobsTx(tx, ctx.accountId, id);
    return (await loadCampaignTx(tx, ctx.accountId, id))!;
  });
}

/** Stop a campaign: recipients still waiting are closed as skipped; a send already under way is not undone. */
export async function cancelCampaign(ctx: Staff, id: string): Promise<CampaignView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    const [campaign] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM shop_email_campaigns WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
    if (!campaign) throw new StoreError('not_found');
    await tx.$executeRaw`UPDATE shop_email_campaigns SET status='cancelled' WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    await tx.$executeRaw`UPDATE shop_email_recipients SET status='skipped', reason='cancelled', settled_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND campaign_id=${id}::uuid AND status='queued'`;
    await auditStoreChange(tx, ctx, 'commerce.email_campaign_cancelled', id, {});
    return (await loadCampaignTx(tx, ctx.accountId, id))!;
  });
}
