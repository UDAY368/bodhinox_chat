// GET  /api/appointments/staff — practitioners, archived last (any member). 200 { staff }.
// POST /api/appointments/staff { display_name, user_id? (a current member) } — admins with
//   appointments.settings, within the plan's appointment_staff limit (402 when reached). 201 { item }.
export const runtime = 'nodejs';

import { createStaff, listStaff } from '@/lib/appointments/config';
import { configCollection } from '../_lib/http';

const handlers = configCollection({ key: 'staff', list: listStaff, create: createStaff });
export const GET = handlers.GET;
export const POST = handlers.POST;
