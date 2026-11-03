// PATCH /api/appointments/staff/[id] { display_name?, user_id?, archived? } — admins with appointments.settings.
//   Restoring an archived practitioner counts against the plan limit again. 200 { item }.
export const runtime = 'nodejs';

import { updateStaff } from '@/lib/appointments/config';
import { configItem } from '../../_lib/http';

const handlers = configItem({ update: updateStaff });
export const PATCH = handlers.PATCH;
