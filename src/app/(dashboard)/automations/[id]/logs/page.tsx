import { redirect } from 'next/navigation';
import { legacyAutomationRedirect } from '@/lib/automations/section-redirect';

// /automations/[id]/logs (before channel sections): the run log in the automation's own channel.
export default async function AutomationLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(await legacyAutomationRedirect({ kind: 'logs', id }));
}
