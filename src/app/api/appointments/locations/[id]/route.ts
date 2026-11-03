// PATCH /api/appointments/locations/[id] { name?, address?, timezone?, kind?, archived? } — admins with
//   appointments.settings. Existing appointments keep their zone snapshot. 200 { item }.
export const runtime = 'nodejs';

import { updateLocation } from '@/lib/appointments/config';
import { configItem } from '../../_lib/http';

const handlers = configItem({ update: updateLocation });
export const PATCH = handlers.PATCH;
