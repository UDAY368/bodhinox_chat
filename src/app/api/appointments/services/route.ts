// GET  /api/appointments/services — every service, archived last (any member). 200 { services }.
// POST /api/appointments/services { name, mode, duration_minutes, buffer_minutes?, slot_step_minutes?, capacity?,
//   price_minor?, currency?, allowed_weekdays?, meeting_url? (online only), feedback_delay_minutes?, rebook_after_days? }
//   Admins with appointments.settings. 201 { item }; payment_required=true is 422 not_yet_supported (payments phase).
export const runtime = 'nodejs';

import { createService, listServices } from '@/lib/appointments/config';
import { configCollection, serviceJson } from '../_lib/http';

const handlers = configCollection({ key: 'services', list: listServices, create: createService, map: serviceJson });
export const GET = handlers.GET;
export const POST = handlers.POST;
