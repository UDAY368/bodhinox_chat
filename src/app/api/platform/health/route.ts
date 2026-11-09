// GET /api/platform/health (platform admins only) - 200 { integrations, backlog, failedJobs, sharedKeyCheck }:
//   per-workspace attention counts from stored status columns, failed/overdue jobs and unprocessed
//   webhook receipts. Counts and ids only; no provider calls. A workspace whose commerce Razorpay key
//   equals the platform billing key is flagged (and a reconciliation item opened) only while
//   BILLING_RAZORPAY_* is configured.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { loadPlatformHealth } from '@/lib/platform/health';

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    return NextResponse.json(await loadPlatformHealth(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
