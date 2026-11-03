// PATCH /api/appointments/services/[id] — any service field, or { archived: boolean } (admins with
//   appointments.settings). 200 { item }. Archiving stops new bookings; existing appointments stay.
export const runtime = 'nodejs';

import { updateService } from '@/lib/appointments/config';
import { configItem, serviceJson } from '../../_lib/http';

const handlers = configItem({ update: updateService, map: serviceJson });
export const PATCH = handlers.PATCH;
