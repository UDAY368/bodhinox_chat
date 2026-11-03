// GET  /api/appointments/locations — every location (any member). 200 { locations }.
// POST /api/appointments/locations { name, timezone (IANA), address?, kind?: 'physical'|'online' } —
//   admins with appointments.settings. 201 { item }.
export const runtime = 'nodejs';

import { createLocation, listLocations } from '@/lib/appointments/config';
import { configCollection } from '../_lib/http';

const handlers = configCollection({ key: 'locations', list: listLocations, create: createLocation });
export const GET = handlers.GET;
export const POST = handlers.POST;
