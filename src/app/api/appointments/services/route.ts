// GET  /api/appointments/services — every service, archived last (any member), each with its intake_form_id.
//   200 { services }.
// POST /api/appointments/services { name, mode, duration_minutes, buffer_minutes?, slot_step_minutes?, capacity?,
//   price_minor?, currency?, payment_required?, allowed_weekdays?, meeting_url? (online only), feedback_delay_minutes?,
//   rebook_after_days? }
//   Admins with appointments.settings. 201 { item }. payment_required=true needs a positive price and currency
//   (400 field payment_required, detail price_required) and, when switched on, the storefront feature with Razorpay
//   connected (400 detail payments_not_ready). Public holds of such a service are confirmed only after payment.
export const runtime = 'nodejs';

import { createService, listServices } from '@/lib/appointments/config';
import { serviceIntakeForms } from '@/lib/appointments/connections';
import { configCollection, serviceJson } from '../_lib/http';

const handlers = configCollection({
  key: 'services',
  list: async (tx, accountId) => {
    const [rows, forms] = await Promise.all([listServices(tx, accountId), serviceIntakeForms(tx, accountId)]);
    return rows.map((r) => ({ ...r, intake_form_id: forms.get(r.id) ?? null }));
  },
  create: createService,
  map: serviceJson,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
