import { timingSafeEqual } from 'node:crypto';
import { scheduleWork } from '@/lib/jobs/handlers';
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected)
    return Response.json(
      { error: 'Scheduler not configured' },
      { status: 503 }
    );
  const supplied = Buffer.from(request.headers.get('x-cron-secret') || '');
  const secret = Buffer.from(expected);
  if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    await scheduleWork();
    return Response.json({ queued: true });
  } catch {
    return Response.json({ error: 'Scheduling unavailable' }, { status: 503 });
  }
}
