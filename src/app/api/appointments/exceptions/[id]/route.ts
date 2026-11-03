// DELETE /api/appointments/exceptions/[id] — admins with appointments.settings. 200 { status: 'deleted' }.
export const runtime = 'nodejs';

import { deleteException } from '@/lib/appointments/config';
import { configItem } from '../../_lib/http';

const handlers = configItem({ remove: deleteException });
export const DELETE = handlers.DELETE;
