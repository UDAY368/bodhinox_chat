// CRM context providers: contact basics, the open deal, and (staff only)
// order and appointment statuses.
//
// Free text typed by people (names, tags, deal titles, stage names) is
// untrusted and goes into a delimited 'crm' block. Statuses are copied from
// the domain tables and labelled as records: the AI only reports them, never
// decides them, and has no write path to them. Contact phone numbers and
// email addresses are never read. Custom fields are left out (they have no
// sensitivity marking yet).

import type { TenantTransaction } from '@/lib/db/tenant';
import { emptyContext, type ContextProvider, type ContextRequest, type ContextResult } from './core';
import { withRequestTenant } from './scope';

const MAX_TEXT = 200;
const clip = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const day = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** The request's contact: the given id, or the conversation's contact. Null when not visible. */
export async function resolveContactId(tx: TenantTransaction, request: ContextRequest): Promise<string | null> {
  if (request.contactId) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM contacts WHERE account_id=${request.accountId}::uuid AND id=${request.contactId}::uuid`;
    return row?.id ?? null;
  }
  if (!request.conversationId) return null;
  const [row] = await tx.$queryRaw<{ contact_id: string }[]>`
    SELECT contact_id FROM conversations WHERE account_id=${request.accountId}::uuid AND id=${request.conversationId}::uuid`;
  return row?.contact_id ?? null;
}

async function withContact(request: ContextRequest, fn: (tx: TenantTransaction, contactId: string) => Promise<ContextResult>): Promise<ContextResult> {
  return withRequestTenant(request, async (tx) => {
    const contactId = await resolveContactId(tx, request);
    return contactId ? fn(tx, contactId) : emptyContext();
  });
}

export const contactBasicsProvider: ContextProvider = {
  key: 'contactBasics',
  minRole: 'agent',
  audiences: ['customer', 'staff'],
  load: (request) => withContact(request, async (tx, contactId) => {
    const out = emptyContext();
    const [contact] = await tx.$queryRaw<{ name: string | null; company: string | null }[]>`
      SELECT name, company FROM contacts WHERE account_id=${request.accountId}::uuid AND id=${contactId}::uuid`;
    const tags = await tx.$queryRaw<{ name: string }[]>`
      SELECT t.name FROM contact_tags ct JOIN tags t ON t.account_id=ct.account_id AND t.id=ct.tag_id
      WHERE ct.account_id=${request.accountId}::uuid AND ct.contact_id=${contactId}::uuid AND t.archived_at IS NULL
      ORDER BY t.name LIMIT 20`;
    const lines = [
      contact?.name ? `Name: ${clip(contact.name)}` : '',
      contact?.company ? `Company: ${clip(contact.company)}` : '',
      tags.length ? `Tags: ${tags.map((t) => clip(t.name)).join(', ')}` : '',
    ].filter(Boolean);
    if (lines.length) out.blocks.push({ source: 'crm', label: 'contact', text: lines.join('\n') });
    out.facts.tag_count = tags.length;
    return out;
  }),
};

export const openDealProvider: ContextProvider = {
  key: 'openDeal',
  minRole: 'agent',
  audiences: ['staff'],
  load: (request) => withContact(request, async (tx, contactId) => {
    const out = emptyContext();
    const [deal] = await tx.$queryRaw<{ title: string; stage: string | null; value: string | null; currency: string | null; expected_close_date: Date | null }[]>`
      SELECT d.title, s.name AS stage, d.value::text AS value, d.currency, d.expected_close_date
      FROM deals d LEFT JOIN pipeline_stages s ON s.account_id=d.account_id AND s.id=d.stage_id
      WHERE d.account_id=${request.accountId}::uuid AND d.contact_id=${contactId}::uuid AND coalesce(d.status,'open')='open'
      ORDER BY d.updated_at DESC NULLS LAST LIMIT 1`;
    out.facts.open_deal = !!deal;
    if (deal) {
      const value = deal.value === null ? null : Number(deal.value);
      out.facts.open_deal_value = value !== null && Number.isFinite(value) ? value : null;
      out.blocks.push({
        source: 'crm', label: 'open deal',
        text: [`Deal: ${clip(deal.title)}`, deal.stage ? `Stage: ${clip(deal.stage)}` : '',
          value !== null ? `Value: ${value} ${clip(deal.currency) || ''}`.trim() : '',
          deal.expected_close_date ? `Expected close: ${day(deal.expected_close_date)}` : ''].filter(Boolean).join('\n'),
      });
    }
    return out;
  }),
};

interface OrderRow {
  id: string;
  status: string;
  currency: string;
  total_minor: bigint | null;
  subtotal_minor: bigint;
  paid_at: Date | null;
  refund_state: string;
  dispatched_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

export const orderStatusProvider: ContextProvider = {
  key: 'orderStatus',
  minRole: 'agent',
  // Statuses are for staff to check, never for a customer-facing answer.
  audiences: ['staff'],
  load: (request) => withContact(request, async (tx, contactId) => {
    const out = emptyContext();
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT id, status, currency, total_minor, subtotal_minor, paid_at, refund_state, dispatched_at, delivered_at, created_at
      FROM orders WHERE account_id=${request.accountId}::uuid AND contact_id=${contactId}::uuid
      ORDER BY created_at DESC LIMIT 3`;
    out.facts.order_count_recent = rows.length;
    if (rows.length) {
      const lines = rows.map((o) => {
        const total = Number(o.total_minor ?? o.subtotal_minor) / 100;
        return `Order ${o.id.slice(0, 8)} (created ${day(o.created_at)}): status ${clip(o.status)}, total ${total} ${clip(o.currency)}, ` +
          `payment ${o.paid_at ? `recorded ${day(o.paid_at)}` : 'not recorded'}, refund ${clip(o.refund_state)}, ` +
          `dispatch ${o.dispatched_at ? `recorded ${day(o.dispatched_at)}` : 'not recorded'}, delivery ${o.delivered_at ? `recorded ${day(o.delivered_at)}` : 'not recorded'}`;
      });
      out.blocks.push({ source: 'crm', label: 'order records (data from the database)', text: lines.join('\n') });
    }
    return out;
  }),
};

export const appointmentStatusProvider: ContextProvider = {
  key: 'appointmentStatus',
  minRole: 'agent',
  audiences: ['staff'],
  load: (request) => withContact(request, async (tx, contactId) => {
    const out = emptyContext();
    const rows = await tx.$queryRaw<{ id: string; service_name: string; start_at: Date; status: string; payment_status: string }[]>`
      SELECT id, service_name, start_at, status, payment_status FROM appointments
      WHERE account_id=${request.accountId}::uuid AND contact_id=${contactId}::uuid
      ORDER BY start_at DESC LIMIT 3`;
    out.facts.appointment_count_recent = rows.length;
    if (rows.length) {
      const lines = rows.map((a) => `Appointment ${a.id.slice(0, 8)}: ${clip(a.service_name)} at ${a.start_at.toISOString().slice(0, 16).replace('T', ' ')} UTC, ` +
        `status ${clip(a.status)}, payment ${clip(a.payment_status)}`);
      out.blocks.push({ source: 'crm', label: 'appointment records (data from the database)', text: lines.join('\n') });
    }
    return out;
  }),
};
