// GET  /api/appointments/booking-pages — booking pages with their service ids (any member). 200 { pages }.
// POST /api/appointments/booking-pages { slug, title, service_ids[], location_id?, whatsapp_config_id?, active? }
//   Admins with appointments.settings. Slugs are global: 400 { field:'slug', detail:'taken' } when used. 201 { item }.
export const runtime = 'nodejs';

import { createBookingPage, listBookingPages } from '@/lib/appointments/config';
import { configCollection } from '../_lib/http';

const handlers = configCollection({ key: 'pages', list: listBookingPages, create: createBookingPage });
export const GET = handlers.GET;
export const POST = handlers.POST;
