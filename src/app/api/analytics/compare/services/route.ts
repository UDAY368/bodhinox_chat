// GET /api/analytics/compare/services?preset=&from=&to=
// Appointment outcomes per service in the range (viewer and above, as
// /api/appointments/stats): booked, confirmed, cancelled, completed, no-shows
// and the no-show rate. Days are each appointment's own local day, as there.

import { appointmentStats, noShowRate } from '@/lib/appointments/stats';
import { AppointmentError } from '@/lib/appointments/types';
import { analyticsReport } from '@/lib/analytics/http';
import { AnalyticsInputError } from '@/lib/analytics/queries';

interface ServiceComparisonRow {
  serviceId: string;
  name: string;
  booked: number;
  confirmed: number;
  cancelled: number;
  completed: number;
  noShow: number;
  /** noShow / (completed + noShow); null when neither was recorded. */
  noShowRate: number | null;
}

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range }) => {
    let rows;
    try {
      ({ rows } = await appointmentStats(tx, accountId, { from: range.startDay, to: range.endDay }));
    } catch (error) {
      if (error instanceof AppointmentError) throw new AnalyticsInputError('Invalid range');
      throw error;
    }
    const byService = new Map<string, ServiceComparisonRow>();
    for (const row of rows) {
      const entry = byService.get(row.service_id)
        ?? { serviceId: row.service_id, name: row.service_name, booked: 0, confirmed: 0, cancelled: 0, completed: 0, noShow: 0, noShowRate: null };
      entry.booked += row.booked;
      entry.confirmed += row.confirmed;
      entry.cancelled += row.cancelled;
      entry.completed += row.completed;
      entry.noShow += row.no_show;
      byService.set(row.service_id, entry);
    }
    const services = [...byService.values()].map((s) => ({ ...s, noShowRate: noShowRate(s.completed, s.noShow) }));
    services.sort((a, b) => b.booked - a.booked || a.name.localeCompare(b.name));
    return { services };
  });
}
