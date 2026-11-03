// PATCH  /api/appointments/booking-pages/[id] { slug?, title?, service_ids?, location_id?, whatsapp_config_id?, active? }
// DELETE /api/appointments/booking-pages/[id]
//   Admins with appointments.settings. 200 { item } / { status: 'deleted' }.
export const runtime = 'nodejs';

import { deleteBookingPage, updateBookingPage } from '@/lib/appointments/config';
import { configItem } from '../../_lib/http';

const handlers = configItem({ update: updateBookingPage, remove: deleteBookingPage });
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
