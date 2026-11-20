// PATCH /api/appointments/services/[id] — any service field, { archived: boolean }, or { intake_form_id: uuid | null }
//   (a published WhatsApp form of this workspace, sent after a booking is confirmed). Admins with
//   appointments.settings. 200 { item }. Archiving stops new bookings; existing appointments stay.
export const runtime = 'nodejs';

import { updateService } from '@/lib/appointments/config';
import { setServiceIntakeForm } from '@/lib/appointments/connections';
import { AppointmentError } from '@/lib/appointments/types';
import { configItem, isId, serviceJson } from '../../_lib/http';

const handlers = configItem<{ id: string; price_minor?: unknown }>({
  update: async (tx, accountId, userId, id, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppointmentError('invalid');
    const { intake_form_id: formId, ...rest } = raw as Record<string, unknown>;
    const hasForm = 'intake_form_id' in raw;
    if (hasForm && formId !== null && !isId(formId)) throw new AppointmentError('invalid');
    const row = Object.keys(rest).length || !hasForm ? await updateService(tx, accountId, userId, id, rest) : null;
    if (!userId) throw new AppointmentError('invalid');
    const intake = hasForm ? await setServiceIntakeForm(tx, accountId, userId, id, formId as string | null) : undefined;
    return { ...(row ?? { id }), ...(intake !== undefined ? { intake_form_id: intake } : {}) };
  },
  map: (row) => serviceJson(row),
});
export const PATCH = handlers.PATCH;
