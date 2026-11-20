import { describe, expect, it } from 'vitest';
import { nodeAvailableOn } from '@/lib/channels/capabilities';
import { INSTAGRAM_LIMITS } from '@/lib/instagram/graph-limits';
import { AD_ATTRIBUTION_DAYS, BROADCAST_ATTRIBUTION_DAYS } from '@/lib/appointments/attribution';
import { REVENUE_WINDOW_DAYS } from '@/lib/meta-ads/insights';
import { trackedButtonIndex } from '@/lib/broadcasts/tracking';
import { validateTemplatePayload } from '@/lib/whatsapp/template-validators';
import { BOOK_NOW_SLUG, bookingLibraryTemplates } from '@/lib/whatsapp/template-library-booking';
import { getLibraryTemplate, libraryTemplatePayload } from '@/lib/whatsapp/template-library';
import {
  APPOINTMENT_STATUS_VALUES, BOOK_APPOINTMENT_VARS, appointmentReplyIds, bookAppointmentPaidIssues, instagramRows, pagedRows,
  parseAppointmentReply, rowTitle,
} from './appointment-node';
import { flowTemplateChannels, getFlowTemplate, listFlowTemplates } from './templates';
import { validateFlowForActivation } from './validate';

// Batch 3 WP-C: the booking step on Instagram (B8), paid flow bookings (A6),
// the booking starters (B10), the "Book now" campaign preset (B11) and the
// attribution windows (B12).

describe('book_appointment on Instagram (B8)', () => {
  it('is allowed on Instagram and WhatsApp', () => {
    expect(nodeAvailableOn('book_appointment', 'instagram').ok).toBe(true);
    expect(nodeAvailableOn('book_appointment', 'whatsapp').ok).toBe(true);
  });

  it('turns a full list page into quick replies with short titles and the same ids', () => {
    const slots = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `A very long practitioner name number ${i}` }));
    const rows = pagedRows(slots, 0, (s) => ({ id: appointmentReplyIds.staff('00000000-0000-4000-8000-00000000000' + (Number(s.id.slice(1)) % 10)), title: rowTitle(s.name) }),
      { more: 'More dates please', cancel: 'Cancel' });
    const ig = instagramRows(rows);
    expect(ig.length).toBe(rows.length);
    expect(ig.length).toBeLessThanOrEqual(INSTAGRAM_LIMITS.quickReplies);
    for (const [i, row] of ig.entries()) {
      expect([...row.title].length).toBeLessThanOrEqual(INSTAGRAM_LIMITS.quickReplyTitleChars);
      expect(row.title.trim()).not.toBe('');
      expect(row.id).toBe(rows[i].id);
    }
    // A tap carries the payload, which parses exactly like a WhatsApp list row.
    expect(parseAppointmentReply(ig[ig.length - 1].id)).toEqual({ kind: 'cancel' });
    expect(parseAppointmentReply(ig[ig.length - 2].id)).toEqual({ kind: 'more' });
  });

  it('keeps a short title whole', () => {
    expect(instagramRows([{ id: 'appt:cancel', title: 'Cancel' }])).toEqual([{ id: 'appt:cancel', title: 'Cancel' }]);
  });
});

describe('paid services in a flow (A6)', () => {
  it('saves the booking status and the booking page link for later steps', () => {
    expect(BOOK_APPOINTMENT_VARS).toEqual(expect.arrayContaining(['appointment_id', 'appointment_local_time', 'appointment_status', 'booking_link']));
    expect(APPOINTMENT_STATUS_VALUES).toEqual({ confirmed: 'confirmed', paymentPending: 'waiting_for_payment' });
  });

  it('refuses a paid service at publish only when publish passes the paid set (no online payments)', () => {
    const node = { node_key: 'b', config: { service_ids: ['11111111-1111-4111-8111-111111111111'] } };
    expect(bookAppointmentPaidIssues(node, undefined)).toEqual([]);
    expect(bookAppointmentPaidIssues(node, new Set(['11111111-1111-4111-8111-111111111111']))).toHaveLength(1);
  });
});

describe('booking starters (B10)', () => {
  const slugs = ['book_keyword', 'ig_story_book', 'ig_comment_book'];

  it('appear in the gallery on the right channels', () => {
    const listed = listFlowTemplates().map((t) => t.slug);
    expect(listed).toEqual(expect.arrayContaining(slugs));
    expect(flowTemplateChannels(getFlowTemplate('book_keyword')!)).toEqual(['whatsapp', 'instagram']);
    expect(flowTemplateChannels(getFlowTemplate('ig_story_book')!)).toEqual(['instagram']);
    expect(flowTemplateChannels(getFlowTemplate('ig_comment_book')!)).toEqual(['instagram']);
  });

  it.each(slugs)('%s validates on every channel it offers, books, and falls back to the booking page link', (slug) => {
    const template = getFlowTemplate(slug)!;
    for (const channel of flowTemplateChannels(template)) {
      const issues = validateFlowForActivation(
        { name: template.name, trigger_type: template.trigger_type, trigger_config: template.trigger_config as Record<string, unknown>,
          entry_node_id: template.entry_node_id, channel_scope: channel },
        template.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> })),
      );
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
    const book = template.nodes.find((n) => n.node_type === 'book_appointment')!;
    const cfg = book.config as Record<string, string>;
    const fallback = template.nodes.find((n) => n.node_key === cfg.unavailable_next)!;
    expect((fallback.config as { text: string }).text).toContain('{{vars.booking_link}}');
    expect(template.nodes.some((n) => n.node_type === 'condition'
      && (n.config as Record<string, unknown>).value === APPOINTMENT_STATUS_VALUES.paymentPending)).toBe(true);
  });

  it('opens booking from a comment only after the private reply button', () => {
    const template = getFlowTemplate('ig_comment_book')!;
    const start = template.nodes.find((n) => n.node_key === 'start')!;
    const first = template.nodes.find((n) => n.node_key === (start.config as { next_node_key: string }).next_node_key)!;
    expect(first.node_type).toBe('ig_private_reply');
    expect((first.config as { next_node_key: string }).next_node_key).toBe('book');
  });
});

describe('"Book now" campaign preset (B11)', () => {
  const origin = 'https://app.example.com';

  it('has a tracked campaign link button and is in the library', () => {
    const [preset] = bookingLibraryTemplates(origin);
    expect(preset.slug).toBe(BOOK_NOW_SLUG);
    expect(preset.buttons).toEqual([{ type: 'URL', text: expect.any(String), url: `${origin}/r/{{1}}`, example: expect.stringMatching(/\/r\/[0-9a-f]{32}$/) }]);
    expect(trackedButtonIndex(preset, origin)).toBe(0);
    expect(getLibraryTemplate(BOOK_NOW_SLUG)).toBeTruthy();
  });

  it('passes the template validator', () => {
    const [preset] = bookingLibraryTemplates(origin);
    const payload = libraryTemplatePayload(preset, 'en');
    expect(payload.body_text).toContain('{{1}}');
    expect(payload.body_text).toContain('{{2}}');
    expect(preset.sample_values.body).toHaveLength(2);
    expect(validateTemplatePayload(payload)).toEqual({ bodyVarCount: 2, headerVarCount: 0 });
  });
});

describe('attribution windows (B12)', () => {
  it('credits a campaign click for 7 days and an ad for the ads revenue window', () => {
    expect(BROADCAST_ATTRIBUTION_DAYS).toBe(7);
    expect(AD_ATTRIBUTION_DAYS).toBe(REVENUE_WINDOW_DAYS);
  });
});
