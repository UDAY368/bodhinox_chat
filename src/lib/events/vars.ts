import { formatAppointmentTime } from '@/lib/appointments/customer-send';
import type { DomainEventRow } from './store';

/**
 * Message variables a rule or flow can use, as strings. Appointment events keep the names the
 * appointment triggers always had; every other event is `event_<field>`.
 */
export function eventVars(event: Pick<DomainEventRow, 'type' | 'data'>): Record<string, string> {
  const vars: Record<string, string> = {};
  if (event.type.startsWith('appointment.')) {
    if (event.data.appointment_id != null) vars.appointment_id = String(event.data.appointment_id);
    if (event.data.service_name != null) vars.appointment_service = String(event.data.service_name);
    if (typeof event.data.start_at === 'string' && typeof event.data.timezone === 'string') {
      vars.appointment_local_time = formatAppointmentTime(new Date(event.data.start_at), event.data.timezone);
    }
    return vars;
  }
  for (const [name, value] of Object.entries(event.data)) {
    if (value !== null && /^[a-z_]{1,40}$/.test(name)) vars[`event_${name}`] = String(value).slice(0, 200);
  }
  return vars;
}
