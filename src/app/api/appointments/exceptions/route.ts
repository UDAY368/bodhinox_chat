// GET  /api/appointments/exceptions?location_id=&from=YYYY-MM-DD&to=YYYY-MM-DD — holidays and exceptions
//   (any member). 200 { exceptions }.
// POST /api/appointments/exceptions { location_id, staff_id?, starts_on, ends_on, ranges?: [{start,end}] | null, reason? }
//   Local dates in the location's zone; ranges null = closed all day. Admins with appointments.settings. 201 { item }.
export const runtime = 'nodejs';

import { createException, listExceptions } from '@/lib/appointments/config';
import { configCollection } from '../_lib/http';

const handlers = configCollection({
  key: 'exceptions',
  list: (tx, accountId, request) => {
    const params = new URL(request.url).searchParams;
    return listExceptions(tx, accountId, {
      locationId: params.get('location_id') ?? undefined, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined,
    });
  },
  create: createException,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
